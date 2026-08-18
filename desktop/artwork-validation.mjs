export const maximumArtworkDifference = 0.08;

export function normalizedArtworkDifference(left, right) {
  if (!left?.length || left.length !== right?.length || left.length % 4 !== 0) {
    return 1;
  }

  let difference = 0;
  for (let index = 0; index < left.length; index += 4) {
    difference += Math.abs(left[index] - right[index]);
    difference += Math.abs(left[index + 1] - right[index + 1]);
    difference += Math.abs(left[index + 2] - right[index + 2]);
  }
  return difference / ((left.length / 4) * 3 * 255);
}
