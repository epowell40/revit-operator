// One geometry contract for provider actions and the existing desktop adapter.
// A supplied path is authoritative: malformed paths never fall back to scalars.
export const MAX_COMPUTER_DRAG_POINTS = 256;

function coordinate(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('Invalid drag coordinate.');
  const rounded = Math.round(value);
  if (rounded < -2147483648 || rounded > 2147483647) throw new Error('Drag coordinate exceeds desktop integer range.');
  return rounded;
}

function point(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid drag point.');
  return { x: coordinate(value.x), y: coordinate(value.y) };
}

export function normalizeComputerDrag(action) {
  if (!action || typeof action !== 'object') throw new Error('Drag geometry is required.');
  let points;
  if (Object.hasOwn(action, 'path')) {
    if (!Array.isArray(action.path) || action.path.length < 2 || action.path.length > MAX_COMPUTER_DRAG_POINTS) {
      throw new Error(`Drag path requires 2 to ${MAX_COMPUTER_DRAG_POINTS} points.`);
    }
    points = Array.from(action.path, point);
  } else {
    points = [
      point({ x: action.x ?? action.start_x ?? action.startX, y: action.y ?? action.start_y ?? action.startY }),
      point({ x: action.end_x ?? action.endX ?? action.to_x ?? action.toX, y: action.end_y ?? action.endY ?? action.to_y ?? action.toY })
    ];
  }
  const button = action.button == null ? 'left' : String(action.button).trim().toLowerCase();
  if (!['left', 'right', 'middle'].includes(button)) throw new Error('Invalid drag mouse button.');
  return { path: points, button };
}

export function computerDragArguments(action, toDesktop = (x, y) => ({ x, y })) {
  const drag = normalizeComputerDrag(action);
  const points = drag.path.map(p => point(toDesktop(p.x, p.y)));
  const start = points[0], end = points.at(-1);
  return ['-Action', 'drag', '-X', `${start.x}`, '-Y', `${start.y}`,
    '-EndX', `${end.x}`, '-EndY', `${end.y}`, '-Button', drag.button,
    '-DragPathJsonBase64', Buffer.from(JSON.stringify(points), 'utf8').toString('base64')];
}

export function summarizeComputerDrag(action) {
  try {
    const { path, button } = normalizeComputerDrag(action);
    const start = path[0], end = path.at(-1);
    return `${button} drag from (${start.x}, ${start.y}) to (${end.x}, ${end.y}) via ${path.length} points`;
  } catch {
    return 'invalid drag geometry';
  }
}
