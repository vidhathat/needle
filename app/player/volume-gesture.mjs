const MIN_KNOB_ANGLE = -135;
const MAX_KNOB_ANGLE = 135;
const KNOB_SWEEP = MAX_KNOB_ANGLE - MIN_KNOB_ANGLE;

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

export function pointerAngleDegrees(clientX, clientY, centerX, centerY) {
  return Math.atan2(clientY - centerY, clientX - centerX) * 180 / Math.PI + 90;
}

export function shortestAngleDelta(fromAngle, toAngle) {
  return ((toAngle - fromAngle + 540) % 360) - 180;
}

export function volumeToKnobAngle(volume) {
  return MIN_KNOB_ANGLE + clamp(volume, 0, 100) / 100 * KNOB_SWEEP;
}

export function knobAngleToVolume(angle) {
  return (clamp(angle, MIN_KNOB_ANGLE, MAX_KNOB_ANGLE) - MIN_KNOB_ANGLE) /
    KNOB_SWEEP * 100;
}

export function createCircularKnobGesture({
  pointerId,
  clientX,
  clientY,
  centerX,
  centerY,
  deadZoneRadius,
  volume,
}) {
  const distanceFromCenter = Math.hypot(clientX - centerX, clientY - centerY);
  return {
    pointerId,
    centerX,
    centerY,
    deadZoneRadius,
    lastPointerAngle: pointerAngleDegrees(clientX, clientY, centerX, centerY),
    knobAngle: volumeToKnobAngle(volume),
    latestVolume: volume,
    inDeadZone: distanceFromCenter < deadZoneRadius,
  };
}

export function advanceCircularKnobGesture(gesture, clientX, clientY) {
  const distanceFromCenter = Math.hypot(
    clientX - gesture.centerX,
    clientY - gesture.centerY,
  );
  const pointerAngle = pointerAngleDegrees(
    clientX,
    clientY,
    gesture.centerX,
    gesture.centerY,
  );

  if (distanceFromCenter < gesture.deadZoneRadius) {
    return {
      gesture: { ...gesture, inDeadZone: true },
      volume: null,
    };
  }

  if (gesture.inDeadZone) {
    return {
      gesture: {
        ...gesture,
        lastPointerAngle: pointerAngle,
        inDeadZone: false,
      },
      volume: null,
    };
  }

  const angularMovement = shortestAngleDelta(gesture.lastPointerAngle, pointerAngle);
  const knobAngle = clamp(
    gesture.knobAngle + angularMovement,
    MIN_KNOB_ANGLE,
    MAX_KNOB_ANGLE,
  );
  const volume = knobAngleToVolume(knobAngle);
  return {
    gesture: {
      ...gesture,
      lastPointerAngle: pointerAngle,
      knobAngle,
      latestVolume: volume,
    },
    volume,
  };
}
