"""
VR WebSocket server for receiving controller data from web browsers.
Adapted from the original vr_robot_teleop.py script.
"""

import asyncio
import json
import ssl
import websockets
import numpy as np
import math
import logging
from typing import Dict, Optional, Set
from scipy.spatial.transform import Rotation as R

from .base import BaseInputProvider, ControlGoal, ControlMode
from ..config import XLeVRConfig

logger = logging.getLogger(__name__)


class VRControllerState:
    """State tracking for a VR controller."""
    
    def __init__(self, hand: str):
        self.hand = hand
        self.grip_active = False
        self.trigger_active = False
        self.thumbstick_active = False  # Track if thumbstick was active (for detecting return to neutral)
        
        # Position tracking for relative movement
        self.origin_position = None
        self.origin_rotation = None
        
        # Quaternion-based rotation tracking (more stable than Euler)
        self.origin_quaternion = None
        self.accumulated_rotation_quat = None  # Accumulated rotation as quaternion
        
        # Rotation tracking for wrist control
        self.z_axis_rotation = 0.0  # For wrist_roll
        self.x_axis_rotation = 0.0  # For wrist_flex (pitch)
        
        # Position tracking
        self.current_position = None
        
        # Rotation tracking
        self.origin_wrist_angle = 0.0
    
    def reset_grip(self):
        """Reset grip state but preserve trigger state."""
        self.grip_active = False
        self.origin_position = None
        self.origin_rotation = None
        self.origin_quaternion = None
        self.accumulated_rotation_quat = None
        self.z_axis_rotation = 0.0
        self.x_axis_rotation = 0.0
    
    def reset_origin(self):
        """Reset origin position and rotation for auto-control mode."""
        self.origin_position = None
        self.origin_rotation = None
        self.origin_quaternion = None
        self.accumulated_rotation_quat = None
        self.z_axis_rotation = 0.0
        self.x_axis_rotation = 0.0


class VRWebSocketServer(BaseInputProvider):
    """WebSocket server for VR controller input."""
    
    def __init__(self, command_queue: asyncio.Queue, config: XLeVRConfig, print_only: bool = False):
        super().__init__(command_queue)
        self.config = config
        self.clients: Set = set()
        self.server = None
        self.print_only = print_only  # New flag for print-only mode
        
        # Controller states
        self.left_controller = VRControllerState("left")
        self.right_controller = VRControllerState("right")
        
        # Robot state tracking (for relative position calculation)
        self.left_arm_origin_position = None
        self.right_arm_origin_position = None
    
    def setup_ssl(self) -> Optional[ssl.SSLContext]:
        """Setup SSL context for WebSocket server."""
        # Automatically generate SSL certificates if they don't exist
        if not self.config.ssl_files_exist:
            logger.info("SSL certificates not found for WebSocket server, attempting to generate them...")
            if not self.config.ensure_ssl_certificates():
                logger.error("Failed to generate SSL certificates for WebSocket server")
                return None
        
        ssl_context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        try:
            ssl_context.load_cert_chain(certfile=self.config.certfile, keyfile=self.config.keyfile)
            logger.info("SSL certificate and key loaded successfully for WebSocket server")
            return ssl_context
        except ssl.SSLError as e:
            logger.error(f"Error loading SSL cert/key: {e}")
            return None
    
    async def start(self):
        """Start the WebSocket server."""
        if not self.config.enable_vr:
            logger.info("VR WebSocket server disabled in configuration")
            return
        
        ssl_context = self.setup_ssl()
        if ssl_context is None:
            logger.error("Failed to setup SSL for WebSocket server")
            return
        
        host = self.config.host_ip
        port = self.config.websocket_port
        
        try:
            self.server = await websockets.serve(
                self.websocket_handler, 
                host, 
                port, 
                ssl=ssl_context
            )
            self.is_running = True
            logger.info(f"VR WebSocket server running on wss://{host}:{port}")
        except Exception as e:
            logger.error(f"Failed to start WebSocket server: {e}")
    
    async def stop(self):
        """Stop the WebSocket server."""
        self.is_running = False
        if self.server:
            self.server.close()
            await self.server.wait_closed()
            logger.info("VR WebSocket server stopped")
    
    async def websocket_handler(self, websocket, path=None):
        """Handle WebSocket connections from VR controllers."""
        client_address = websocket.remote_address
        logger.info(f"VR client connected: {client_address}")
        self.clients.add(websocket)
        
        try:
            async for message in websocket:
                try:
                    data = json.loads(message)
                    await self.process_controller_data(data)
                except json.JSONDecodeError:
                    logger.warning(f"Received non-JSON message: {message}")
                except Exception as e:
                    logger.error(f"Error processing VR data: {e}")
                    # Add more context for debugging
                    logger.error(f"Data that caused error: {data}")
                    import traceback
                    logger.error(f"Traceback: {traceback.format_exc()}")
        
        except websockets.exceptions.ConnectionClosedOK:
            logger.info(f"VR client {client_address} disconnected normally")
        except websockets.exceptions.ConnectionClosedError as e:
            logger.warning(f"VR client {client_address} disconnected with error: {e}")
        except Exception as e:
            logger.error(f"Unexpected error with VR client {client_address}: {e}")
        finally:
            self.clients.discard(websocket)
            # Handle grip releases when client disconnects
            await self.handle_grip_release('left')
            await self.handle_grip_release('right')
            logger.info(f"VR client {client_address} cleanup complete")
    
    async def process_controller_data(self, data: Dict):
        """Process incoming VR controller data."""
        packet_ts_ms = data.get("timestamp", None)
        # 检查是否有摇杆或按钮操作，只在有操作时打印
        has_thumbstick_or_button_activity = False
        thumbstick_info = []
        button_info = []
        
        # 检查左右手柄的摇杆和按钮状态
        for hand in ['leftController', 'rightController']:
            if hand in data:
                controller_data = data[hand]
                hand_name = hand.replace('Controller', '').upper()
                
                # 检查摇杆
                if 'thumbstick' in controller_data:
                    thumbstick = controller_data['thumbstick']
                    x = thumbstick.get('x', 0)
                    y = thumbstick.get('y', 0)
                    # 只在摇杆有实际输入时打印（阈值0.1）
                    if abs(x) > 0.1 or abs(y) > 0.1:
                        has_thumbstick_or_button_activity = True
                        thumbstick_info.append(f"[{hand_name}] Thumbstick: x={x:.2f}, y={y:.2f}")
                
                # 检查按钮
                if 'buttons' in controller_data:
                    buttons = controller_data['buttons']
                    pressed_buttons = []
                    for button_name, is_pressed in buttons.items():
                        if is_pressed:
                            has_thumbstick_or_button_activity = True
                            pressed_buttons.append(button_name)
                    
                    if pressed_buttons:
                        button_info.append(f"[{hand_name}] Buttons: {', '.join(pressed_buttons)}")
        
        # Avoid spamming stdout during recording; keep available at DEBUG level.
        if has_thumbstick_or_button_activity:
            if thumbstick_info or button_info:
                logger.debug("[VR_WS] Activity detected:\n  %s", "\n  ".join([*thumbstick_info, *button_info]))
        
        # Process controller data
        if 'leftController' in data:
            left_data = dict(data['leftController'])
            left_data["_packet_ts_ms"] = packet_ts_ms
            await self.process_single_controller('left', left_data)
        
        if 'rightController' in data:
            right_data = dict(data['rightController'])
            right_data["_packet_ts_ms"] = packet_ts_ms
            await self.process_single_controller('right', right_data)
        
        # Process headset data for head control
        if 'headset' in data:
            await self.process_headset(data['headset'])
    
    async def process_single_controller(self, hand: str, data: Dict):
        """Process data for a single controller."""
        position = data.get('position', {})
        rotation = data.get('rotation', {})
        quaternion = data.get('quaternion', {})  # Get quaternion data directly
        grip_active = data.get('gripActive', False)
        trigger = data.get('trigger', 0)
        thumbstick = data.get('thumbstick', {})
        buttons = data.get('buttons', {})  # Get button states
        packet_ts_ms = data.get("_packet_ts_ms", None)
        # Lerobot send_feedback expects metadata["vr_position"] as [x, y, z] to detect valid VR data
        vr_position = [float(position.get('x', 0)), float(position.get('y', 0)), float(position.get('z', 0))]

        controller = self.left_controller if hand == 'left' else self.right_controller
        
        # Handle trigger for gripper control with continuous float values
        # Ensure trigger is a float (0.0 to 1.0)
        trigger = float(trigger)
        trigger = max(0.0, min(1.0, trigger))  # Clamp to valid range
        trigger_active = trigger > 0.5  # Keep for backward compatibility/logging
        
        # Always send trigger value for continuous gripper control
        # The LeRobot side will handle the continuous mapping
        controller.trigger_active = trigger_active
        
        # Send gripper control goal with continuous trigger value
        # Note: gripper_closed is kept for backward compatibility but trigger value takes precedence
        gripper_goal = ControlGoal(
            arm=hand,
            gripper_closed=not trigger_active,  # Inverted: closed when trigger NOT active (for backward compatibility)
            metadata={
                "source": "vr_trigger",
                "trigger": trigger,  # Continuous float value (0.0 to 1.0)
                "trigger_active": trigger_active,  # Boolean for backward compatibility
                "thumbstick": thumbstick,
                "buttons": buttons,  # Include button states
                "packet_ts_ms": packet_ts_ms,
                "vr_position": vr_position,  # For lerobot send_feedback validation
            }
        )
        await self.send_goal(gripper_goal)
        
        # Handle grip button for arm movement control
        # Arms ONLY move when grip button is pressed (squeeze to activate)
        if grip_active:
            if not controller.grip_active:
                # Grip just activated - set origin and reset target position
                controller.grip_active = True
                # Reset thumbstick tracking since grip is now controlling
                controller.thumbstick_active = False
                # Convert position dict to numpy array for proper subtraction later
                controller.origin_position = np.array([position.get('x', 0), position.get('y', 0), position.get('z', 0)])
                
                # Use quaternion data directly if available, otherwise fall back to Euler conversion
                if quaternion and all(k in quaternion for k in ['x', 'y', 'z', 'w']):
                    controller.origin_quaternion = np.array([quaternion['x'], quaternion['y'], quaternion['z'], quaternion['w']])
                    controller.origin_rotation = controller.origin_quaternion  # Store for compatibility
                else:
                    # Fallback to Euler angle conversion
                    controller.origin_quaternion = self.euler_to_quaternion(rotation) if rotation else None
                    controller.origin_rotation = controller.origin_quaternion
                
                controller.accumulated_rotation_quat = controller.origin_quaternion
                controller.z_axis_rotation = 0.0
                controller.x_axis_rotation = 0.0
                
                # Send reset signal to control loop to reset target position to current robot position
                reset_goal = ControlGoal(
                    arm=hand,
                    mode=ControlMode.POSITION_CONTROL,  # Keep in position control
                    target_position=None,  # Special signal
                    metadata={
                        "source": f"vr_grip_reset_{hand}",
                        "reset_target_to_current": True,  # Signal to reset target to current position
                        "trigger": trigger,
                        "trigger_active": trigger_active,
                        "thumbstick": thumbstick,
                        "buttons": buttons,
                        "packet_ts_ms": packet_ts_ms,
                        "vr_position": vr_position,
                    }
                )
                await self.send_goal(reset_goal)
                
                logger.debug(
                    f"🔒 {hand.upper()} grip activated - controlling {hand} arm (target reset to current position)"
                )
            
            # Compute target position
            if controller.origin_position is not None:
                # Convert position dict to numpy array for proper subtraction
                position_array = np.array([position.get('x', 0), position.get('y', 0), position.get('z', 0)])
                
                # Ensure origin_position is a numpy array
                if isinstance(controller.origin_position, dict):
                    # If origin_position is still a dict, convert it to numpy array
                    logger.warning(f"origin_position was dict, converting to numpy array for {hand} controller")
                    controller.origin_position = np.array([controller.origin_position.get('x', 0), controller.origin_position.get('y', 0), controller.origin_position.get('z', 0)])
                elif not isinstance(controller.origin_position, np.ndarray):
                    # If origin_position is neither dict nor numpy array, log warning and skip
                    logger.warning(f"origin_position is {type(controller.origin_position)}, skipping position calculation for {hand} controller")
                    return
                
                relative_delta = (position_array - controller.origin_position) * self.config.vr_to_robot_scale
                
                # Calculate Z-axis rotation for wrist_roll control
                # Calculate X-axis rotation for wrist_flex control
                if controller.origin_quaternion is not None:
                    # Update quaternion-based rotation tracking
                    if quaternion and all(k in quaternion for k in ['x', 'y', 'z', 'w']):
                        # Use quaternion data directly
                        current_quat = np.array([quaternion['x'], quaternion['y'], quaternion['z'], quaternion['w']])
                        self.update_quaternion_rotation_direct(controller, current_quat)
                    else:
                        # Fallback to Euler angle conversion
                        self.update_quaternion_rotation(controller, rotation)
                    
                    # Get accumulated rotations from quaternion
                    controller.z_axis_rotation = self.extract_roll_from_quaternion(controller.accumulated_rotation_quat, controller.origin_quaternion)
                    controller.x_axis_rotation = self.extract_pitch_from_quaternion(controller.accumulated_rotation_quat, controller.origin_quaternion)
                
                # Create position control goal
                # Note: We send relative position here, the control loop will handle
                # adding it to the robot's current position
                goal = ControlGoal(
                    arm=hand,
                    mode=ControlMode.POSITION_CONTROL,
                    target_position=relative_delta,  # Relative position delta
                    wrist_roll_deg=-controller.z_axis_rotation,
                    wrist_flex_deg=-controller.x_axis_rotation,
                    metadata={
                        "source": "vr_grip",
                        "relative_position": True,
                        "origin_position": controller.origin_position.tolist(),
                        "trigger": trigger,
                        "trigger_active": trigger_active,
                        "thumbstick": thumbstick,
                        "gripActive": True,
                        "buttons": buttons,
                        "packet_ts_ms": packet_ts_ms,
                        "vr_position": vr_position,
                    }
                )
                await self.send_goal(goal)
        else:
            # Handle grip release - stop arm movement when grip button is released
            if controller.grip_active:
                await self.handle_grip_release(hand)
            
            # When grip is NOT active, still send thumbstick data for base movement
            # This allows base control independent of arm control
            if thumbstick:
                thumbstick_x = thumbstick.get('x', 0)
                thumbstick_y = thumbstick.get('y', 0)
                
                # Check if thumbstick is currently active (above threshold)
                thumbstick_has_input = abs(thumbstick_x) > 0.1 or abs(thumbstick_y) > 0.1
                
                if thumbstick_has_input:
                    # Thumbstick is active - send base control goal
                    base_goal = ControlGoal(
                        arm=hand,
                        metadata={
                            "source": "vr_thumbstick_only",
                            "thumbstick": thumbstick,
                            "trigger": trigger,
                            "trigger_active": trigger_active,
                            "gripActive": False,
                            "base_control_only": True,
                            "buttons": buttons,
                            "packet_ts_ms": packet_ts_ms,
                            "vr_position": vr_position,
                        }
                    )
                    await self.send_goal(base_goal)
                    controller.thumbstick_active = True
                    
                elif controller.thumbstick_active:
                    # Thumbstick returned to neutral - send explicit STOP command
                    stop_goal = ControlGoal(
                        arm=hand,
                        metadata={
                            "source": "vr_thumbstick_stop",
                            "thumbstick": {"x": 0, "y": 0},
                            "trigger": trigger,
                            "trigger_active": trigger_active,
                            "gripActive": False,
                            "base_control_only": True,
                            "base_stop": True,
                            "buttons": buttons,
                            "packet_ts_ms": packet_ts_ms,
                            "vr_position": vr_position,
                        }
                    )
                    await self.send_goal(stop_goal)
                    controller.thumbstick_active = False
                    logger.debug(f"🛑 {hand.upper()} thumbstick returned to neutral - base STOP")
    
    async def handle_grip_release(self, hand: str):
        """Handle grip release for a controller."""
        if hand == 'left':
            controller = self.left_controller
        elif hand == 'right':
            controller = self.right_controller
        else:
            return
        
        if controller.grip_active:
            controller.reset_grip()
            
            # Send idle goal to stop arm control
            goal = ControlGoal(
                arm=hand,
                mode=ControlMode.IDLE,
                metadata={
                    "source": "vr_grip_release",
                    "trigger": 0.0,
                    "trigger_active": False,
                    "thumbstick": {},
                    "buttons": {}  # Include button states (empty when grip released)
                }
            )
            await self.send_goal(goal)
            
            logger.debug(f"🔓 {hand.upper()} grip released - arm control stopped")
    
    async def handle_trigger_release(self, hand: str):
        """Handle trigger release for a controller."""
        controller = self.left_controller if hand == 'left' else self.right_controller
        
        if controller.trigger_active:
            controller.trigger_active = False
            
            # Send gripper closed goal - reversed behavior: gripper closes when trigger released
            goal = ControlGoal(
                arm=hand,
                gripper_closed=True,  # Close gripper when trigger released
                metadata={
                    "source": "vr_trigger_release",
                    "trigger": 0.0,
                    "trigger_active": False,
                    "thumbstick": {},
                    "buttons": {}  # Include button states (empty when trigger released)
                }
            )
            await self.send_goal(goal)
            
            logger.debug(f"🤏 {hand.upper()} gripper CLOSED (trigger released)")
    
    def euler_to_quaternion(self, euler_deg: Dict[str, float]) -> np.ndarray:
        """Convert Euler angles in degrees to quaternion [x, y, z, w]."""
        euler_rad = [math.radians(euler_deg['x']), math.radians(euler_deg['y']), math.radians(euler_deg['z'])]
        rotation = R.from_euler('xyz', euler_rad)
        return rotation.as_quat()
    
    def update_quaternion_rotation(self, controller: VRControllerState, current_euler: dict):
        """Update quaternion-based rotation tracking."""
        if not current_euler:
            return
        
        # Convert current Euler to quaternion
        current_quat = self.euler_to_quaternion(current_euler)
        
        # Store current quaternion for accumulated rotation calculation
        controller.accumulated_rotation_quat = current_quat
    
    def update_quaternion_rotation_direct(self, controller: VRControllerState, current_quat: np.ndarray):
        """Update quaternion-based rotation tracking using quaternion data directly."""
        if current_quat is None:
            return
        
        # Store current quaternion for accumulated rotation calculation
        controller.accumulated_rotation_quat = current_quat
    
    def extract_roll_from_quaternion(self, current_quat: np.ndarray, origin_quat: np.ndarray) -> float:
        """Extract roll rotation around Z-axis from relative quaternion rotation."""
        if current_quat is None or origin_quat is None:
            return 0.0
        
        try:
            # Calculate relative rotation quaternion (from origin to current)
            origin_rotation = R.from_quat(origin_quat)
            current_rotation = R.from_quat(current_quat)
            relative_rotation = current_rotation * origin_rotation.inv()
            
            # Project the relative rotation onto the Z-axis (roll)
            # Get the rotation vector (axis-angle representation)
            rotvec = relative_rotation.as_rotvec()
            
            # The Z-component of the rotation vector represents rotation around Z-axis (roll)
            z_rotation_rad = rotvec[2]
            z_rotation_deg = -np.degrees(z_rotation_rad)
            
            return z_rotation_deg
        except Exception as e:
            logger.warning(f"Error extracting roll from quaternion: {e}")
            return 0.0
    
    def extract_pitch_from_quaternion(self, current_quat: np.ndarray, origin_quat: np.ndarray) -> float:
        """Extract pitch rotation around X-axis from relative quaternion rotation."""
        if current_quat is None or origin_quat is None:
            return 0.0
        
        try:
            # Calculate relative rotation quaternion (from origin to current)
            origin_rotation = R.from_quat(origin_quat)
            current_rotation = R.from_quat(current_quat)
            relative_rotation = current_rotation * origin_rotation.inv()
            
            # Project the relative rotation onto the X-axis (pitch)
            # Get the rotation vector (axis-angle representation)
            rotvec = relative_rotation.as_rotvec()
            
            # The X-component of the rotation vector represents rotation around X-axis (pitch)
            x_rotation_rad = rotvec[0]
            x_rotation_deg = np.degrees(x_rotation_rad)
            
            return x_rotation_deg
        except Exception as e:
            logger.warning(f"Error extracting pitch from quaternion: {e}")
            return 0.0
    
    async def process_headset(self, data: Dict):
        """Process headset orientation data for head control."""
        try:
            # Extract quaternion or rotation data
            quaternion = data.get('quaternion', {})
            rotation = data.get('rotation', {})
            
            # Initialize headset origin on first use
            if not hasattr(self, 'headset_origin_quaternion'):
                self.headset_origin_quaternion = None
                logger.info("🎧 Headset control initialized - origin set on first orientation")
            
            # Convert quaternion or rotation to Euler angles
            head_pan_deg = 0.0  # Yaw (left/right)
            head_tilt_deg = 0.0  # Pitch (up/down)
            
            if quaternion and all(k in quaternion for k in ['x', 'y', 'z', 'w']):
                # Use quaternion directly
                current_quat = np.array([quaternion['x'], quaternion['y'], quaternion['z'], quaternion['w']])
                
                # Set origin on first use
                if self.headset_origin_quaternion is None:
                    self.headset_origin_quaternion = current_quat.copy()
                    logger.info("🎧 Headset origin quaternion set")
                
                # Calculate relative rotation from origin
                try:
                    origin_rotation = R.from_quat(self.headset_origin_quaternion)
                    current_rotation = R.from_quat(current_quat)
                    relative_rotation = current_rotation * origin_rotation.inv()
                    
                    # Extract Euler angles (ZYX order: yaw, pitch, roll)
                    euler_angles = relative_rotation.as_euler('ZYX', degrees=True)
                    # Final mapping: VR headset rotation (yaw) controls robot head pan (rotation/side-to-side)
                    # VR headset pitch (nodding up/down) controls robot head tilt (up/down)
                    head_pan_deg = euler_angles[1]  # Yaw (inverted for natural movement) -> controls pan (rotation/side-to-side)
                    head_tilt_deg = euler_angles[2]  # Pitch (nodding) -> controls tilt (up/down)
                except Exception as e:
                    logger.debug(f"Error processing headset quaternion: {e}")
            elif rotation:
                # Fallback to Euler angles if quaternion not available
                # Final mapping: VR headset rotation (yaw) controls robot head pan (rotation)
                # VR headset pitch (nodding) controls robot head tilt (up/down)
                head_pan_deg = -rotation.get('yaw', 0.0)  # Yaw (inverted) -> controls pan (rotation/side-to-side)
                head_tilt_deg = rotation.get('pitch', 0.0)  # Pitch (nodding) -> controls tilt (up/down)
            
            # Create headset control goal
            headset_goal = ControlGoal(
                arm="headset",
                mode=ControlMode.POSITION_CONTROL,
                target_position=None,
                metadata={
                    "source": "vr_headset",
                    "head_pan": head_pan_deg,
                    "head_tilt": head_tilt_deg,
                }
            )
            await self.send_goal(headset_goal)
            
        except Exception as e:
            logger.warning(f"Error processing headset data: {e}")
    
    async def broadcast_camera_frame(self, cam_name: str, jpeg_bytes: bytes):
        """Send a JPEG-encoded robot camera frame to all connected VR clients.

        Sent as a binary WebSocket message with a small wire header so the browser can tell
        which camera the frame belongs to: [1 byte name length][name utf-8 bytes][JPEG bytes].
        This is unambiguous against the JSON text control messages the client sends (control
        data flows the other direction, client -> server), so no separate connection or extra
        framing is needed.
        """
        if not self.clients:
            return

        name_bytes = cam_name.encode("utf-8")[:255]
        frame = bytes([len(name_bytes)]) + name_bytes + jpeg_bytes

        stale_clients = set()
        for client in self.clients:
            try:
                await client.send(frame)
            except websockets.exceptions.ConnectionClosed:
                stale_clients.add(client)
        self.clients -= stale_clients

    async def broadcast_status(self, status: dict):
        """Send small JSON status info (task/episode/elapsed time) to all connected VR clients.

        Sent as a text WebSocket message tagged {"type": "status", ...status} so the client's
        onmessage handler can tell it apart from binary camera frames (see
        broadcast_camera_frame) without ambiguity — the client never receives any other JSON
        message from the server today.
        """
        if not self.clients:
            return

        message = json.dumps({"type": "status", **status})

        stale_clients = set()
        for client in self.clients:
            try:
                await client.send(message)
            except websockets.exceptions.ConnectionClosed:
                stale_clients.add(client)
        self.clients -= stale_clients

    async def send_goal(self, goal: ControlGoal):
        """Send a control goal to the command queue or print it if in print-only mode."""
        if self.print_only:
            # Print the ControlGoal in a formatted way
            print(f"\n🎮 ControlGoal:")
            print(f"   Arm: {goal.arm}")
            print(f"   Mode: {goal.mode}")
            if goal.target_position is not None:
                print(f"   Target Position: [{goal.target_position[0]:.3f}, {goal.target_position[1]:.3f}, {goal.target_position[2]:.3f}]")
            if goal.wrist_roll_deg is not None:
                print(f"   Wrist Roll: {goal.wrist_roll_deg:.1f}°")
            if goal.wrist_flex_deg is not None:
                print(f"   Wrist Flex: {goal.wrist_flex_deg:.1f}°")
            if goal.gripper_closed is not None:
                print(f"   Gripper: {'CLOSED' if goal.gripper_closed else 'OPEN'}")
            if goal.metadata:
                print(f"   Metadata: {goal.metadata}")
            print()
        else:
            # Use the parent class method to send to queue
            await super().send_goal(goal) 