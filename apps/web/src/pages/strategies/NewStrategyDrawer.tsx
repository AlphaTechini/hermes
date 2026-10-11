import { Plus } from "lucide-react";
import { useState } from "react";
import { MARKET_SYMBOLS, type StrategySecretDTO } from "@hermes/shared";
import { errorMessage } from "../../lib/api";
import { useCreateStrategy } from "../../lib/queries";
import { Button, Drawer, Input, NumberInput, Select, useToast } from "../../components/ui";
import { ConnectBody } from "./ConnectBody";

/** New strategy drawer: Name, Market, Size, Leverage. After creating, the same Connect section appears with the real secret. */
export function NewStrategyDrawer({ open, onClose, onOpenStrategy }: { open: boolean; onClose: () => void; onOpenStrategy: (id: string) => void }) {
  const toast = useToast();
  const create = useCreateStrategy();
  const [name, setName] = useState("");
  const [market, setMarket] = useState<string>("BTC");
  const [sizeUsd, setSizeUsd] = useState<number | null>(null);
  const [leverage, setLeverage] = useState<number | null>(5);
  const [touched, setTouched] = useState(false);
  const [created, setCreated] = useState<StrategySecretDTO | null>(null);

  const close = () => {
    onClose();
    // Reset after the drawer is gone so the secret never lingers in memory.
    setTimeout(() => {
      setCreated(null);
      setName("");
      setSizeUsd(null);
      setLeverage(5);
      setTouched(false);
    }, 200);
  };

  const nameError = touched && !name.trim() ? "Give the strategy a name." : undefined;
  const levError = leverage !== null && leverage <= 0 ? "Leverage must be above 0x." : undefined;

  const submit = () => {
    setTouched(true);
    if (!name.trim() || levError) return;
    create.mutate(
      { name: name.trim(), defaultMarket: market, defaultSizeUsd: sizeUsd, defaultLeverage: leverage },
      {
        onSuccess: (s) => setCreated(s),
        onError: (e) => toast.negative("Could not create the strategy", errorMessage(e)),
      },
    );
  };

  return (
    <Drawer
      open={open}
      onClose={close}
      title={created ? "Strategy created" : "New strategy"}
      footer={
        created ? (
          <>
            <Button variant="ghost" onClick={close}>
              Close
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                const id = created.id;
                close();
                onOpenStrategy(id);
              }}
            >
              Open strategy
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button variant="primary" icon={Plus} loading={create.isPending} loadingLabel="Creating" onClick={submit}>
              Create strategy
            </Button>
          </>
        )
      }
    >
      {created ? (
        <div className="col g4">
          <p className="secondary" style={{ fontSize: 13, lineHeight: "20px" }}>
            <b className="fg">{created.name}</b> is ready. Paste these 3 fields into your TradingView alert.
          </p>
          <ConnectBody strategy={created} initial={created} />
        </div>
      ) : (
        <form
          className="col g4"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <Input label="Name" placeholder="Breakout 15m" value={name} onChange={(e) => setName(e.target.value)} error={nameError} maxLength={80} autoFocus data-autofocus />
          <Select label="Market" value={market} onChange={setMarket} options={MARKET_SYMBOLS.map((m) => ({ value: m as string, label: m, market: m }))} hint="Used when the message has no market." />
          <NumberInput label="Size" prefix="$" unit="per order" value={sizeUsd} onValueChange={setSizeUsd} min={0} placeholder="From the alert" hint="Leave empty to use the size in the TradingView message." />
          <NumberInput label="Leverage if the alert has none" unit="x" value={leverage} onValueChange={setLeverage} min={0} error={levError} hint="Your risk limit caps this." />
          <button type="submit" hidden />
        </form>
      )}
    </Drawer>
  );
}
