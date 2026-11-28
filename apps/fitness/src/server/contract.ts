/**
 * The oldest records contract (`X-Fitness-Contract`) Fitness serves. Raise
 * it when stored data starts using a shape that older iPhone builds refuse,
 * once a build that reads it is available. Until then, saves that need a
 * newer contract are refused, so every stored record stays readable by the
 * builds Fitness serves.
 *
 * Contract 2 stores carbs, fat and fibre and the nutrients settings track.
 * Release the iPhone build that declares 2 to TestFlight before the
 * website release that raises the minimum to 2.
 *
 * Contract 3 stores load types on exercises outside the catalogue and the
 * planning profile. Both apps label weights by load type, leave weight
 * entry out of band exercises and show the planning profile. Release the
 * iPhone build that declares 3 to TestFlight before the website release
 * that raises the minimum to 3.
 */
const defaultMinimum = 3;
let minimum = defaultMinimum;
export function minimumAppContract() {
  return minimum;
}
/** Sets the minimum contract, or restores the default, for tests. */
export function setMinimumAppContractForTests(value = defaultMinimum) {
  minimum = value;
}
