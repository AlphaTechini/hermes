import { KeyRound } from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { PerplConnectionDTO } from "@hermes/shared";
import { useEmbeddedWallet } from "../../auth/hooks";
import type { TypedDataInput } from "../../auth/context";
import { Button } from "../../components/ui/Button";
import { Card, CardBody } from "../../components/ui/Card";
import { Callout } from "../../components/ui/Feedback";
import { errorMessage, post } from "../../lib/api";
import { qk } from "../../lib/queries";

/**
 * One-click Perpl API key: the server asks Perpl for the key payload, the embedded wallet signs it in the Privy dialog,
 * and the server finishes the enrolment and saves the key. Needed because the Privy wallet cannot connect to
 * testnet.perpl.xyz to create a key there.
 */
export function CreateKeyCard({ onSaved }: { onSaved?: () => void }) {
  const wallet = useEmbeddedWallet();
  const qc = useQueryClient();
  const create = useMutation({
    mutationFn: async () => {
      const { typedData } = await post<{ address: string; typedData: TypedDataInput }>("/api/perpl/enroll/start");
      const signature = await wallet.signTypedData(typedData);
      return post<PerplConnectionDTO>("/api/perpl/enroll/finish", { signature });
    },
    onSuccess: (c) => {
      qc.setQueryData(qk.perpl, c);
      onSaved?.();
    },
  });

  return (
    <Card>
      <CardBody>
        <div className="col" style={{ gap: 12 }}>
          <div>
            <b>Create the key with your wallet</b>
            <p className="m" style={{ margin: "4px 0 0" }}>
              One signature in the Privy dialog. Hermes keeps the key encrypted. It can place orders but never withdraw.
            </p>
          </div>
          <div>
            <Button variant="primary" icon={KeyRound} disabled={!wallet.ready} loading={create.isPending} loadingLabel="Creating key" onClick={() => create.mutate()}>
              Create API key
            </Button>
          </div>
          {create.isError && <Callout tone="negative">{errorMessage(create.error)}</Callout>}
        </div>
      </CardBody>
    </Card>
  );
}
