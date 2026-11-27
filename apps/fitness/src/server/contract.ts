/**
 * The oldest records contract (`X-Fitness-Contract`) Fitness serves. Raise
 * it when stored data starts using a shape that older iPhone builds refuse,
 * once a build that reads it is available. Until then, saves that need a
 * newer contract are refused, so every stored record stays readable by the
 * builds Fitness serves.
 */
const defaultMinimum = 1;
let minimum = defaultMinimum;
export function minimumAppContract() {
  return minimum;
}
/** Sets the minimum contract, or restores the default, for tests. */
export function setMinimumAppContractForTests(value = defaultMinimum) {
  minimum = value;
}
