import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { Copy } from "lucide-react";
import { Button, CodeBlock, CopyField, DataTable, IconButton, LifecyclePipeline, Meter, SegmentedControl, StatusPill, Toggle, ToastProvider, useToast, MarketChip, SideLabel, NumberInput, Select } from ".";
import { useState } from "react";

const wrap = (ui: React.ReactElement) => render(<MemoryRouter>{ui}</MemoryRouter>);

describe("Button", () => {
  it("renders variants and sizes as prototype classes", () => {
    render(<Button variant="primary" size="lg">Go</Button>);
    const b = screen.getByRole("button", { name: "Go" });
    expect(b).toHaveClass("btn", "btn-primary", "btn-lg");
  });
  it("loading shows the gerund and ignores clicks", async () => {
    const onClick = vi.fn();
    render(<Button loading loadingLabel="Saving" onClick={onClick}>Save</Button>);
    const b = screen.getByRole("button", { name: /Saving/ });
    expect(b).toHaveAttribute("data-loading", "true");
    expect(b).toHaveAttribute("aria-busy", "true");
    fireEvent.click(b);
    expect(onClick).not.toHaveBeenCalled();
  });
  it("IconButton has an aria-label and is square", () => {
    render(<IconButton icon={Copy} label="Copy ID" />);
    const b = screen.getByRole("button", { name: "Copy ID" });
    expect(b).toHaveClass("btn-icon");
  });
});

describe("StatusPill", () => {
  it("covers every outcome label", () => {
    const kinds = ["in_flight", "needs_approval", "filled", "partly_filled", "blocked", "not_filled", "rejected", "ignored", "expired"] as const;
    const labels = ["In flight", "Needs approval", "Filled", "Partly filled", "Blocked", "Not filled", "Rejected by Perpl", "Ignored", "Expired"];
    const { container } = render(<>{kinds.map((k) => <StatusPill key={k} kind={k} />)}</>);
    labels.forEach((l) => expect(screen.getByText(l)).toBeInTheDocument());
    expect(container.querySelector(".pill.positive")).toBeTruthy();
    expect(container.querySelector(".pill.warning")).toBeTruthy();
    expect(container.querySelector(".pill.negative")).toBeTruthy();
    expect(container.querySelector(".pill.accent .hm-dot[data-live=true]")).toBeTruthy();
  });
});

describe("chips and sides", () => {
  it("market chip and side label", () => {
    render(<><MarketChip market="BTC" /><SideLabel side="short" /><SideLabel side="close-long" /></>);
    expect(screen.getByText("BTC")).toHaveClass("mkt");
    expect(screen.getByText("Short").closest(".side")).toHaveClass("short");
    expect(screen.getByText("Close long").closest(".side")).toHaveClass("secondary");
  });
});

describe("LifecyclePipeline", () => {
  const stages = [
    { state: "done", label: "0 ms" }, { state: "done", label: "+4 ms" }, { state: "blocked", label: "+1 ms" },
    { state: "skipped", label: "" }, { state: "skipped", label: "" }, { state: "skipped", label: "" },
  ] as const;
  it("has six stages with states and an accessible label", () => {
    const { container } = render(<LifecyclePipeline stages={[...stages]} size="lg" />);
    const group = screen.getByRole("img");
    expect(group.getAttribute("aria-label")).toMatch(/Received done.*Checked blocked/);
    expect(container.querySelectorAll(".hm-pipe__stage")).toHaveLength(6);
    expect(container.querySelector('[data-state="blocked"]')).toBeTruthy();
    expect(screen.getByText("Accepted")).toBeInTheDocument();
  });
  it("marks a stage that just completed for the fill animation", () => {
    const active = [{ state: "done", label: "0 ms" }, { state: "done", label: "" }, { state: "done", label: "" }, { state: "done", label: "" }, { state: "active", label: "…" }, { state: "pending", label: "" }] as const;
    const { container, rerender } = render(<LifecyclePipeline stages={[...active]} />);
    expect(container.querySelector("[data-animate]")).toBeNull();
    rerender(<LifecyclePipeline stages={active.map((s, i) => (i === 4 ? { state: "done", label: "+184 ms" } : i === 5 ? { state: "active", label: "…" } : s)) as never} />);
    expect(container.querySelectorAll('[data-animate="fill"]')).toHaveLength(1);
  });
});

describe("DataTable", () => {
  interface R { id: string; px: number }
  const rows: R[] = [{ id: "a", px: 1 }, { id: "b", px: 2 }];
  it("right-aligns numeric columns and hides secondary columns on mobile via class", () => {
    const { container } = wrap(
      <DataTable rows={rows} rowKey={(r) => r.id} columns={[{ key: "id", header: "Id", cell: (r) => r.id }, { key: "px", header: "Price", numeric: true, hideSm: true, cell: (r) => r.px }]} />,
    );
    expect(container.querySelector("th.num.hide-sm")).toBeTruthy();
    expect(container.querySelectorAll("td.num")).toHaveLength(2);
  });
  it("fires onRowClick and supports Enter", async () => {
    const on = vi.fn();
    const { container } = wrap(<DataTable rows={rows} rowKey={(r) => r.id} onRowClick={on} columns={[{ key: "id", header: "Id", cell: (r) => r.id }]} />);
    const tr = container.querySelectorAll("tbody tr")[1] as HTMLElement;
    expect(tr).toHaveClass("clickable");
    fireEvent.click(tr);
    expect(on).toHaveBeenCalledWith(rows[1], 1);
    tr.focus();
    fireEvent.keyDown(tr, { key: "Enter" });
    expect(on).toHaveBeenCalledTimes(2);
  });
  it("renders the empty slot and skeleton rows", () => {
    const { rerender } = wrap(<DataTable rows={[]} rowKey={(r: R) => r.id} empty={<div>Nothing here</div>} columns={[{ key: "id", header: "Id", cell: (r: R) => r.id }]} />);
    expect(screen.getByText("Nothing here")).toBeInTheDocument();
    rerender(<MemoryRouter><DataTable loading skeletonRows={3} rows={[]} rowKey={(r: R) => r.id} empty={<div>Nothing here</div>} columns={[{ key: "id", header: "Id", cell: (r: R) => r.id }]} /></MemoryRouter>);
    expect(document.querySelectorAll("tbody tr")).toHaveLength(3);
  });
});

describe("CopyField", () => {
  it("copies the full value, not the masked display, and flips to Copied", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<CopyField secret label="Secret" value="whsec_9fT2mQ7vLc4Rk8Zp1Xn6hx2K" />);
    expect(screen.getByText(/^•+hx2K$/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Copy secret" }));
    expect(writeText).toHaveBeenCalledWith("whsec_9fT2mQ7vLc4Rk8Zp1Xn6hx2K");
    await waitFor(() => expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument());
  });
  it("reveals the secret", async () => {
    render(<CopyField secret value="whsec_abc123hx2K" />);
    await userEvent.click(screen.getByRole("button", { name: "Show secret" }));
    expect(screen.getByText("whsec_abc123hx2K")).toBeInTheDocument();
  });
});

describe("CodeBlock", () => {
  it("highlights JSON tokens and copies copyValue", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const { container } = render(<CodeBlock title="Message" code={'{\n  "secret": "••••",\n  "price": "{{close}}",\n  "n": 5\n}'} copyValue="REAL" copyLabel="Copy message" />);
    expect(container.querySelector("pre .k")?.textContent).toBe('"secret"');
    expect(container.querySelector("pre .v")?.textContent).toBe("{{close}}");
    expect(container.querySelector("pre .n")?.textContent).toBe("5");
    await userEvent.click(screen.getByRole("button", { name: /Copy message/ }));
    expect(writeText).toHaveBeenCalledWith("REAL");
  });
});

describe("Toggle, Segmented, Meter, NumberInput, Select", () => {
  it("toggle reports changes", async () => {
    const on = vi.fn();
    render(<Toggle checked={false} onCheckedChange={on} label="Enabled" />);
    await userEvent.click(screen.getByRole("switch", { name: "Enabled" }));
    expect(on).toHaveBeenCalledWith(true);
  });
  it("segmented marks the selected item with aria-pressed", async () => {
    const on = vi.fn();
    render(<SegmentedControl aria-label="Filter" value="all" onChange={on} options={[{ value: "all", label: "All", count: 47 }, { value: "filled", label: "Filled", count: 41 }]} />);
    expect(screen.getByRole("button", { name: /All/ })).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(screen.getByRole("button", { name: /Filled/ }));
    expect(on).toHaveBeenCalledWith("filled");
  });
  it("meter derives tone from usage", () => {
    const { container, rerender } = render(<Meter value={27} max={100} />);
    expect(container.querySelector(".meter")).toHaveAttribute("data-tone", "ok");
    rerender(<Meter value={84} max={100} />);
    expect(container.querySelector(".meter")).toHaveAttribute("data-tone", "warning");
    rerender(<Meter value={500} max={500} />);
    expect(container.querySelector(".meter")).toHaveAttribute("data-tone", "negative");
  });
  it("number input parses grouped text and formats on blur", async () => {
    function T() {
      const [v, setV] = useState<number | null>(null);
      return <><NumberInput aria-label="Max" value={v} onValueChange={setV} unit="bps" /><output>{String(v)}</output></>;
    }
    render(<T />);
    const input = screen.getByLabelText("Max");
    await userEvent.type(input, "25000");
    fireEvent.blur(input);
    expect((input as HTMLInputElement).value).toBe("25,000");
    expect(document.querySelector("output")?.textContent).toBe("25000");
    expect(screen.getByText("bps")).toHaveClass("affix");
  });
  it("select opens a listbox and picks an option", async () => {
    const on = vi.fn();
    render(<Select aria-label="Market" label="Market" value="BTC" onChange={on} options={[{ value: "BTC", label: "BTC" }, { value: "ETH", label: "ETH" }]} />);
    await userEvent.click(screen.getByRole("combobox"));
    await userEvent.click(screen.getByRole("option", { name: "ETH" }));
    expect(on).toHaveBeenCalledWith("ETH");
  });
});

describe("Toast", () => {
  function Fire() {
    const t = useToast();
    return <button onClick={() => { t.positive("One"); t.positive("Two"); t.positive("Three"); t.negative("Four", "bad"); }}>fire</button>;
  }
  it("stacks at most three, newest last", async () => {
    render(<MemoryRouter><ToastProvider><Fire /></ToastProvider></MemoryRouter>);
    await userEvent.click(screen.getByText("fire"));
    expect(screen.queryByText("One")).toBeNull();
    const titles = Array.from(document.querySelectorAll(".toast .tt")).map((e) => e.textContent);
    expect(titles).toEqual(["Two", "Three", "Four"]);
  });
});
