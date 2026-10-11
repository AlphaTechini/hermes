import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../lib/api";
import { KEY_ERROR_CODES, describeKeyError } from "./key-errors";
import { ApiKeyForm, TxHash, txPill } from "./parts";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const fail = (status: number, code: string) => json(status, { error: { code, message: `server: ${code}` } });

function renderForm(extra: Partial<React.ComponentProps<typeof ApiKeyForm>> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ApiKeyForm {...extra} />
    </QueryClientProvider>,
  );
}

const fillAndSubmit = (account?: string) => {
  fireEvent.change(screen.getByLabelText("Key ID"), { target: { value: "ak_1" } });
  fireEvent.change(screen.getByLabelText("Private key"), { target: { value: "secret" } });
  if (account) {
    fireEvent.click(screen.getByRole("button", { name: /Advanced: account ID/ }));
    fireEvent.change(screen.getByLabelText("Perpl account ID"), { target: { value: account } });
  }
  fireEvent.click(screen.getByRole("button", { name: /Verify and continue/ }));
};

afterEach(() => vi.unstubAllGlobals());

describe("describeKeyError", () => {
  it("has its own plain copy for every server code", () => {
    const seen = new Set<string>();
    for (const code of KEY_ERROR_CODES) {
      const c = describeKeyError(new ApiError(400, code, "raw server text"));
      expect(c.code).toBe(code);
      expect(c.title.length).toBeGreaterThan(10);
      expect(c.body).not.toContain("raw server text");
      expect(`${c.title} ${c.body}`).not.toMatch(/[–—]/);
      seen.add(c.title);
    }
    expect(seen.size).toBe(KEY_ERROR_CODES.length);
  });

  it("offers the forwarding action only for perpl_forwarding_disabled", () => {
    expect(describeKeyError(new ApiError(409, "perpl_forwarding_disabled", "x")).action).toBe("allow_forwarding");
    expect(describeKeyError(new ApiError(400, "perpl_key_rejected", "x")).action).toBeUndefined();
  });

  it("tells a missing account apart from a wrong account ID", () => {
    const missing = describeKeyError(new ApiError(400, "perpl_account_not_found", "x"), { accountSupplied: false });
    const wrong = describeKeyError(new ApiError(400, "perpl_account_not_found", "x"), { accountSupplied: true });
    expect(missing.action).toBe("back_to_account");
    expect(wrong.field).toBe("accountId");
    expect(missing.title).not.toBe(wrong.title);
  });

  it("falls back to the server message for unknown codes", () => {
    const c = describeKeyError(new ApiError(500, "boom", "Something broke"));
    expect(c.body).toContain("Something broke.");
    expect(c.body).toContain("not saved");
  });
});

describe("ApiKeyForm", () => {
  it("keeps the account ID collapsed and omits it from the request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(200, { configured: true, status: "connected", accountId: "7", apiKeyPublic: "ak_1", collateral: null, createdAt: 1, lastRq: null, mode: "sim" }));
    vi.stubGlobal("fetch", fetchMock);
    renderForm();
    const toggle = screen.getByRole("button", { name: /Advanced: account ID/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByLabelText("Perpl account ID")).toBeNull();
    fillAndSubmit();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body).toEqual({ apiKeyPublic: "ak_1", apiKeyPrivate: "secret" });
  });

  it("sends the account ID when one is typed", async () => {
    const fetchMock = vi.fn().mockResolvedValue(fail(400, "perpl_key_rejected"));
    vi.stubGlobal("fetch", fetchMock);
    renderForm();
    fillAndSubmit("4821");
    await screen.findByText("Perpl rejected this key.");
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body as string).accountId).toBe("4821");
  });

  it("opens Advanced and explains when the account cannot be found", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(fail(400, "perpl_account_not_found")));
    renderForm();
    fillAndSubmit();
    await screen.findByText(/could not find a Perpl account for this wallet/);
    expect(screen.getByRole("button", { name: /Advanced: account ID/ })).toHaveAttribute("aria-expanded", "true");
  });

  it("runs Allow order forwarding, then verifies the key again", async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      calls.push(`${init.method} ${url}`);
      if (url.endsWith("/api/wallet/actions")) return json(200, { id: "w1", kind: "allow_forwarding", status: "confirmed", txHash: "0xabc", error: null, simulated: true, description: "x", to: "0x", data: "0x", value: "0", createdAt: 1 });
      const puts = calls.filter((c) => c.startsWith("PUT")).length;
      return puts === 1 ? fail(409, "perpl_forwarding_disabled") : json(200, { configured: true, status: "connected", accountId: "7", apiKeyPublic: "ak_1", collateral: null, createdAt: 1, lastRq: null, mode: "sim" });
    });
    vi.stubGlobal("fetch", fetchMock);
    const onSaved = vi.fn();
    renderForm({ onSaved });
    fillAndSubmit();
    const btn = await screen.findByRole("button", { name: "Allow order forwarding" });
    fireEvent.click(btn);
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(calls).toEqual(["PUT /api/perpl/connection", "POST /api/wallet/actions", "PUT /api/perpl/connection"]);
  });

  it.each([
    ["perpl_invalid_key_format", "That private key is not in the right format."],
    ["perpl_key_rejected", "Perpl rejected this key."],
    ["perpl_geo_blocked", "Perpl is not available from where Hermes runs."],
    ["perpl_unreachable", "Hermes could not reach Perpl."],
    ["perpl_timeout", "Perpl did not answer in time."],
  ])("shows the copy for %s", async (code, title) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(fail(400, code)));
    renderForm();
    fillAndSubmit();
    expect(await screen.findByText(title)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Allow order forwarding" })).toBeNull();
  });
});

describe("TxHash", () => {
  it("links real hashes to the explorer", () => {
    render(<TxHash hash="0x3b9e000000000000000000000000000000000000000000000000000000077a1" />);
    expect(screen.getByRole("link")).toHaveAttribute("href", expect.stringContaining("/tx/0x3b9e"));
  });

  it("shows simulated hashes as plain text with a Simulated tag and no link", () => {
    render(<TxHash hash="0x3b9e000000000000000000000000000000000000000000000000000000077a1" simulated />);
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("Simulated")).toBeInTheDocument();
    expect(screen.getByText(/0x3b9e/)).toBeInTheDocument();
  });
});

describe("txPill", () => {
  it("labels a wallet policy refusal differently from a Hermes block", () => {
    render(<>{txPill("denied")}</>);
    expect(screen.getByText("Refused by policy")).toBeInTheDocument();
    expect(screen.queryByText("Blocked")).toBeNull();
  });
});
