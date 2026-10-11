import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppErrorBoundary, RouteErrorBoundary } from "./ErrorBoundary";

let broken = true;
function Bomb() {
  if (broken) throw new Error("list.reduce is not a function");
  return <p>Page content</p>;
}

const wrap = (ui: React.ReactNode, at = "/approvals") => (
  <QueryClientProvider client={new QueryClient()}>
    <MemoryRouter initialEntries={[at]}>
      <Routes>
        <Route path="/live" element={<p>Live page</p>} />
        <Route path="*" element={ui} />
      </Routes>
    </MemoryRouter>
  </QueryClientProvider>
);

beforeEach(() => {
  broken = true;
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("error boundaries", () => {
  it("route level: shows the error state with Retry and Back to Live, and recovers on Retry", async () => {
    render(wrap(<RouteErrorBoundary><Bomb /></RouteErrorBoundary>));
    expect(screen.getByRole("alert")).toHaveTextContent("This page hit an error");
    expect(screen.getByText("list.reduce is not a function")).toBeInTheDocument();
    broken = false;
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(screen.getByText("Page content")).toBeInTheDocument();
  });

  it("route level: Back to Live navigates", async () => {
    render(wrap(<RouteErrorBoundary><Bomb /></RouteErrorBoundary>));
    await userEvent.click(screen.getByRole("button", { name: "Back to Live" }));
    expect(screen.getByText("Live page")).toBeInTheDocument();
  });

  it("app level: catches errors outside any route boundary", () => {
    render(wrap(<AppErrorBoundary><Bomb /></AppErrorBoundary>));
    expect(screen.getByRole("alert")).toHaveTextContent("Hermes hit an error");
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Back to Live" })).toBeInTheDocument();
  });

  it("offers a reload after a second failure", async () => {
    render(wrap(<RouteErrorBoundary><Bomb /></RouteErrorBoundary>));
    expect(screen.queryByRole("button", { name: "Reload page" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(screen.getByRole("button", { name: "Reload page" })).toBeInTheDocument();
  });
});
