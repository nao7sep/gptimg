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
      onPaintMask={() => {}}
    />
  ));
  return { onSend };
}

describe("the composer", () => {
  it("sends on Enter with the chosen shape, quality and background", async () => {
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
          onPaintMask={() => {}}
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
    fireEvent.change(screen.getByRole("combobox", { name: "Background" }), { target: { value: "transparent" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith({ text: "a red fox", references: [] }, { size: "1024x1536", quality: "low", background: "transparent" });
  });

  it("takes an exact size only once the image model would take it", async () => {
    const onSend = vi.fn();
    fakeApi();
    const { Composer } = await import("../../src/renderer/src/components/Composer.tsx");
    const { I18nProvider } = await import("../../src/renderer/src/i18n.tsx");
    const { language } = await import("./harness.tsx");
    const { render } = await import("@testing-library/react");
    function Host() {
      return (
        <Composer
          draft={{ text: "a lighthouse", references: [] }}
          onDraft={() => {}}
          options={{ size: "auto", quality: "auto", background: "opaque" }}
          imageModel="gpt-image-2.5-sunburst"
          busy={false}
          keyMissing={false}
          sessionDir={null}
          focusRef={{ current: () => {} }}
          attachRef={{ current: () => {} }}
          onSend={onSend}
          onCancel={() => {}}
          onOpenSettings={() => {}}
          onPaintMask={() => {}}
        />
      );
    }
    render(
      <I18nProvider initial={language}>
        <Host />
      </I18nProvider>,
    );
    const select = vi.spyOn(HTMLInputElement.prototype, "select");
    fireEvent.click(screen.getByRole("radio", { name: "Exact size" }));
    const [width, height] = screen.getAllByRole("spinbutton");
    expect(document.activeElement).toBe(width);
    fireEvent.change(width!, { target: { value: "1000" } });
    // Selected once on opening, never again while typing, so the next digit adds to the field.
    expect(select).toHaveBeenCalledTimes(1);
    select.mockRestore();
    expect(screen.getByRole("alert").textContent).toBe("Each side must be a multiple of 16.");
    expect(screen.getByRole("button", { name: "Use this size" })).toHaveProperty("disabled", true);
    fireEvent.change(width!, { target: { value: "4000" } });
    fireEvent.change(height!, { target: { value: "1024" } });
    expect(screen.getByRole("alert").textContent).toBe("The longer side can be at most 3 times the shorter.");
    fireEvent.change(width!, { target: { value: "3840" } });
    fireEvent.change(height!, { target: { value: "2160" } });
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Use this size" }));
    expect(screen.getByRole("radio", { name: "Exact size" }).textContent).toBe("3840\u00d72160");
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Message" }), { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith({ text: "a lighthouse", references: [] }, { size: "3840x2160", quality: "auto", background: "opaque" });
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
      onPaintMask={() => {}}
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


async function configuredComposer(imageOnly: boolean) {
  fakeApi();
  const onSend = vi.fn();
  const { Composer } = await import("../../src/renderer/src/components/Composer.tsx");
  await renderInApp(() => <Composer
    draft={{ text: imageOnly ? " " : "A lighthouse", references: imageOnly ? [{ path: "/reference.png", absolute: "/reference.png" }] : [] }}
    onDraft={() => {}}
    options={{ size: "auto", quality: "xhigh" }}
    imageModel="gpt-image-2"
    busy={false}
    keyMissing={false}
    sessionDir={null}
    focusRef={{ current: () => {} }}
    attachRef={{ current: () => {} }}
    onSend={onSend}
    onCancel={() => {}}
    onOpenSettings={() => {}}
    onPaintMask={() => {}}
  />);
  return onSend;
}

it("keeps image-only submission disabled until there is a text instruction", async () => {
  const onSend = await configuredComposer(true);
  expect(screen.getByRole("button", { name: "Send" })).toHaveProperty("disabled", true);
  fireEvent.keyDown(screen.getByRole("textbox", { name: "Message" }), { key: "Enter" });
  expect(onSend).not.toHaveBeenCalled();
});

it("submits the displayed supported quality when the saved quality is incompatible with the model", async () => {
  const onSend = await configuredComposer(false);
  const quality = screen.getByRole("combobox", { name: "Quality" }) as HTMLSelectElement;
  expect(quality.value).not.toBe("xhigh");
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  expect(onSend).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ quality: quality.value }));
});
