import { ArrowRight, ArrowUpRight, Coins, Droplet } from "lucide-react";
import { useAuth } from "../../auth/context";
import { useEmbeddedWallet } from "../../auth/hooks";
import { Button } from "../../components/ui/Button";
import { Card, CardBody, CardHeader } from "../../components/ui/Card";
import { Divider } from "../../components/ui/Misc";
import { Skeleton } from "../../components/ui/Skeleton";
import { explorerAddressUrl } from "../../lib/format";
import { useSignerConfig } from "../../lib/queries";
import { MON_FAUCET_URL, useWalletBalances } from "../wallet/hooks";
import { AddressField, Balances, PolicySummary, SignerAction } from "../wallet/parts";
import type { StepProps } from "./types";

/** Step 1: the embedded wallet, its balances, faucet links and the Hermes signer under the Privy policy. */
export function StepWallet({ signerAdded, keyDone, go }: StepProps) {
  const canContinue = signerAdded || keyDone;
  const { user } = useAuth();
  const wallet = useEmbeddedWallet();
  const address = wallet.address ?? user?.walletAddress ?? null;
  const cfg = useSignerConfig();
  const bal = useWalletBalances(address, cfg.data?.policy.collateralToken);

  return (
    <>
      <div>
        <h2>Your wallet is ready</h2>
        <p className="lead">Privy created this wallet when you signed in. Hermes uses it to open your Perpl account and make deposits. It needs a little MON for gas and test AUSD to deposit.</p>
      </div>

      <Card>
        <CardBody className="col g3">
          <AddressField address={address} />
        </CardBody>
        <Divider />
        <Balances balances={bal.data} loading={bal.isLoading} />
      </Card>

      <Card>
        <CardHeader title="Need test funds?" meta="Free, testnet only" />
        <div className="checks">
          <div className="chk skip">
            <Droplet aria-hidden />
            <div>
              <div className="n" style={{ color: "var(--text)" }}>
                MON for gas
              </div>
              <div className="d">Monad faucet. Rate limited.</div>
            </div>
            <a className="ext xs" href={MON_FAUCET_URL} target="_blank" rel="noopener">
              faucet.monad.xyz
              <ArrowUpRight aria-hidden />
            </a>
          </div>
          <div className="chk skip">
            <Coins aria-hidden />
            <div>
              <div className="n" style={{ color: "var(--text)" }}>
                Test AUSD
              </div>
              <div className="d">Agora faucet. One request per minute, shared by everyone. Hermes can request it for you in the next step.</div>
            </div>
            {cfg.data ? <a className="ext xs" href={explorerAddressUrl(cfg.data.policy.faucet)} target="_blank" rel="noopener">
                Agora faucet
                <ArrowUpRight aria-hidden />
              </a> : <Skeleton w={72} h={12} />}
          </div>
        </div>
      </Card>

      <Card>
        <CardHeader title="Allow Hermes to send Perpl setup transactions" meta={signerAdded ? "Allowed" : "One time"} />
        <CardBody className="col g4">
          <p className="secondary" style={{ fontSize: 13, lineHeight: "20px" }}>
            Hermes signs the faucet request, the approval and the account creation from its server, so you do not confirm each one. Privy checks every transaction against the policy below before it signs.
          </p>
          <SignerAction config={cfg.data} added={signerAdded} addressReady={Boolean(address)} />
        </CardBody>
        <Divider />
        <CardBody>
          {cfg.data ? <PolicySummary policy={cfg.data.policy} mode={cfg.data.mode} /> : <Skeleton h={120} />}
        </CardBody>
      </Card>

      <div className="ob-foot">
        <span className="xs muted">{canContinue ? "Balances refresh every block." : "Allow Hermes above to continue."}</span>
        <Button variant="primary" size="lg" disabled={!canContinue} onClick={() => go(2)}>
          Continue
          <ArrowRight aria-hidden />
        </Button>
      </div>
    </>
  );
}
