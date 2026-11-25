import { requireNativeModule } from "expo";

type FitnessHealthNative = {
  healthDataAvailable(): boolean;
};

export const FitnessHealth = requireNativeModule<FitnessHealthNative>("FitnessHealth");
