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
 * Both apps label weights by load type (loadWording in the shared domain)
 * and leave weight entry out of band exercises. Before raising the minimum
 * to 3, ship an iPhone build that declares contract 3, then release it to
 * TestFlight ahead of the website. Records below contract 3 hold only
 * dumbbell loads.
 */
const defaultMinimum = 2;
let minimum = defaultMinimum;
export function minimumAppContract() {
  return minimum;
}
/** Sets the minimum contract, or restores the default, for tests. */
export function setMinimumAppContractForTests(value = defaultMinimum) {
  minimum = value;
}
