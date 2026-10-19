// @vitest-environment jsdom
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeApi, renderInApp } from "./harness.tsx";

afterEach(cleanup);

async function composer(onSend = vi.fn()) {
  fakeApi();
  const { Composer } = await import("../../src/renderer/src/components/Composer.tsx");
  await renderInApp(() => (
    <Composer
      draft={{ text: "", references: [] }}
      onDraft={() => {}}
      options={{ size: "auto", quality: "auto" }}
      imageModel="gpt-image-2.5-sunburst"
      busy={false}
      keyMissing={false}
      sessionDir={null}
      focusRef={{ current: () => {} }}
      attachRef={{ current: () => {} }}
      onSend={onSend}
      onCancel={() => {}}
      onOpenSettings={() => {}}
    />
  ));
  return { onSend };
}

describe("the composer", () => {
  it("sends on Enter with the chosen shape, quality and transparency", async () => {
    const onSend = vi.fn();
    fakeApi();
    const { Composer } = await import("../../src/renderer/src/components/Composer.tsx");
    const { I18nProvider } = await import("../../src/renderer/src/i18n.tsx");
    const { language } = await import("./harness.tsx");
    const { render } = await import("@testing-library/react");
    const { useState } = await import("react");
    function Host() {
      const [draft, setDraft] = useState({ text: "", references: [] as { path: string; absolute: string }[] });
      return (
        <Composer
          draft={draft}
          onDraft={setDraft}
          options={{ size: "auto", quality: "auto" }}
          imageModel="gpt-image-2.5-sunburst"
          busy={false}
          keyMissing={false}
          sessionDir={null}
          focusRef={{ current: () => {} }}
          attachRef={{ current: () => {} }}
          onSend={onSend}
          onCancel={() => {}}
          onOpenSettings={() => {}}
        />
      );
    }
    render(
      <I18nProvider initial={language}>
        <Host />
      </I18nProvider>,
    );
    const field = screen.getByRole("textbox", { name: "Message" });
    fireEvent.change(field, { target: { value: "a red fox" } });
    fireEvent.click(screen.getByRole("radio", { name: "Portrait" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Quality" }), { target: { value: "low" } });
    fireEvent.click(screen.getByRole("button", { name: "Transparent background" }));
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith({ text: "a red fox", references: [] }, { size: "1024x1536", quality: "low", transparent: true });
  });

  it("does not send while an input method is composing, nor on Shift+Enter", async () => {
    const onSend = vi.fn();
    fakeApi();
    const { Composer } = await import("../../src/renderer/src/components/Composer.tsx");
    await renderInApp(() => (
      <Composer
        draft={{ text: "かえる", references: [] }}
        onDraft={() => {}}
        options={{ size: "auto", quality: "auto" }}
        imageModel="gpt-image-2.5-sunburst"
        busy={false}
        keyMissing={false}
        sessionDir={null}
        focusRef={{ current: () => {} }}
        attachRef={{ current: () => {} }}
        onSend={onSend}
        onCancel={() => {}}
        onOpenSettings={() => {}}
      />
    ));
    const field = screen.getByRole("textbox", { name: "Message" });
    fireEvent.compositionStart(field);
    fireEvent.keyDown(field, { key: "Enter", keyCode: 229 });
    fireEvent.keyDown(field, { key: "Enter", shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
  });

  it("offers Send only when there is something to send", async () => {
    await composer();
    expect(screen.getByRole("button", { name: "Send" })).toHaveProperty("disabled", true);
  });
});
