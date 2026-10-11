export interface StepProps {
  /** Move to another step (updates `?step=`). */
  go: (step: number) => void;
  /** Hermes signer registered on the embedded wallet. */
  signerAdded: boolean;
  /** Perpl account exists (created onchain, or a simulated one connected). */
  accountDone: boolean;
  /** Perpl API key saved and verified. */
  keyDone: boolean;
}
