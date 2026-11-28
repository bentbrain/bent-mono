/**
 * The oldest records contract (`X-Fitness-Contract`) Fitness serves. Raise
 * it when stored data starts using a shape that older iPhone builds refuse,
 * once a build that reads it is available. Until then, saves that need a
 * newer contract are refused, so every stored record stays readable by the
 * builds Fitness serves.
 *
 * Before raising it to 2, label weights by load type in both apps (plan
 * suggestions, workout and correction loggers, VoiceOver hints, guides and
 * strength charts all say "per dumbbell" today), leave weight entry out of
 * band exercises, and ship an iPhone build that declares contract 2.
 * Contract 1 records hold only dumbbell loads.
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
