// @vitest-environment jsdom
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeApi, renderInApp } from "./harness.tsx";

afterEach(cleanup);

describe("the in-window menu", () => {
  it("lists the fleet's order and chooses by keyboard", async () => {
    fakeApi();
    const onCommand = vi.fn();
    const { AppMenu } = await import("../../src/renderer/src/components/AppMenu.tsx");
    await renderInApp(() => <AppMenu mac onCommand={onCommand} />);
    fireEvent.click(screen.getByRole("button", { name: "Menu" }));
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent?.replace(/Cmd.*$/, ""))).toEqual([
      "New chat",
      "Show chats folder",
      "Settings",
      "Records",
      "Keyboard Shortcuts",
      "About GptImg",
    ]);
    expect(screen.getAllByRole("menuitem")[0]!.textContent).toBe("New chatCmd+N");
    const menu = screen.getByRole("menu");
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    fireEvent.keyDown(menu, { key: "Enter" });
    expect(onCommand).toHaveBeenCalledWith("records");
  });
});
