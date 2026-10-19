import { describe, expect, it } from "vitest";
import { maskCredentials, maskDiagnosticCopy, maskUrlQuery, urlQueryValues } from "../../src/events/mask.ts";

describe("credential masking helpers", () => {
  it("replaces every occurrence of each credential with the fixed marker, keeping the scheme", () => {
    expect(maskCredentials("Bearer sk-abc, again sk-abc", ["sk-abc", ""])).toBe("Bearer [REDACTED], again [REDACTED]");
  });

  it("masks a provider's partial echo of a key, and only of that key", () => {
    const key = "sk-proj-abcdefghijklmnopWXYZ";
    expect(maskCredentials("Incorrect API key provided: sk-proj-****************WXYZ. See docs.", [key])).toBe(
      "Incorrect API key provided: [REDACTED]. See docs.",
    );
    expect(maskCredentials("sk-other-****************WXYZ", [key])).toBe("sk-other-****************WXYZ");
    expect(maskCredentials("short****WXYZ", ["shortWXYZ"])).toBe("short****WXYZ");
  });

  it("masks every query value of a URL and leaves a URL without one alone", () => {
    expect(maskUrlQuery("https://h.example/img.png?se=2026&sig=tok#frag")).toBe(
      "https://h.example/img.png?se=[REDACTED]&sig=[REDACTED]#frag",
    );
    expect(maskUrlQuery("https://h.example/img.png")).toBe("https://h.example/img.png");
    expect(maskUrlQuery("not a url")).toBe("not a url");
  });

  it("lists raw and standard decoded query values without duplicates", () => {
    expect(urlQueryValues("https://h.example/a?se=2026-10-05&sig=a%2Bb&flag&empty=#x")).toEqual(["2026-10-05", "a%2Bb", "a+b"]);
    expect(urlQueryValues("https://h.example/a?sig=a%2Fb%2Bc%3Dd&token=signed+value%2Btail")).toEqual([
      "a%2Fb%2Bc%3Dd", "a/b+c=d", "signed+value%2Btail", "signed value+tail",
    ]);
    expect(urlQueryValues("https://h.example/a?sig=bad%escape")).toEqual(["bad%escape"]);
    expect(urlQueryValues("https://h.example/a")).toEqual([]);
  });

  it("copies a diagnostic graph without mutating live errors, headers or JSON", () => {
    const credential = "test-secret";
    const body = { message: `echo ${credential}`, count: 1, ok: true };
    const headers = new Headers({ authorization: `Bearer ${credential}`, "retry-after": "1" });
    const cause = new TypeError(`cause ${credential}`);
    const error = new AggregateError([cause, body], `failed ${credential}`, { cause });
    Object.defineProperties(error, {
      code: { value: "provider.failure", enumerable: false },
      status: { value: 401, enumerable: false },
      body: { value: body, enumerable: false },
      headers: { value: headers, enumerable: false },
    });
    const graph = { error, body, headers, list: [error, body], self: null as unknown };
    graph.self = graph;

    const copy = maskDiagnosticCopy(graph, [credential]);
    expect(copy).not.toBe(graph);
    expect(copy.self).toBe(copy);
    expect(copy.list).toEqual([copy.error, copy.body]);
    expect(copy.list[0]).toBe(copy.error);
    expect(copy.list[1]).toBe(copy.body);
    expect(copy.error).toBeInstanceOf(AggregateError);
    expect(Object.getPrototypeOf(copy.error)).toBe(Object.getPrototypeOf(error));
    expect(Object.prototype.toString.call(copy.error)).toBe("[object Error]");
    expect(String(copy.error)).toBe("AggregateError: failed [REDACTED]");
    expect(copy.error.cause).toBeInstanceOf(TypeError);
    expect(copy.error.errors).toEqual([copy.error.cause, copy.body]);
    expect(copy.error.errors[1]).toBe(copy.body);
    expect(copy.error.message).toBe("failed [REDACTED]");
    expect(copy.error.stack).toContain("failed [REDACTED]");
    expect(copy.error.stack).not.toContain(credential);
    expect(copy.error).toMatchObject({ code: "provider.failure", status: 401, body: copy.body, headers: copy.headers });
    expect(Object.getOwnPropertyDescriptor(copy.error, "body")?.enumerable).toBe(false);
    expect(copy.body).toEqual({ message: "echo [REDACTED]", count: 1, ok: true });
    expect(copy.headers).toBeInstanceOf(Headers);
    expect(copy.headers).not.toBe(headers);
    expect(copy.headers.get("authorization")).toBe("Bearer [REDACTED]");
    expect(copy.headers.get("retry-after")).toBe("1");
    copy.headers.set("retry-after", "2");
    expect(headers.get("retry-after")).toBe("1");
    expect(error.message).toBe(`failed ${credential}`);
    expect(error.stack).toContain(credential);
    expect(cause.message).toBe(`cause ${credential}`);
    expect(body.message).toBe(`echo ${credential}`);
    expect(headers.get("authorization")).toBe(`Bearer ${credential}`);
    expect(maskDiagnosticCopy(`Bearer ${credential}`, [credential])).toBe("Bearer [REDACTED]");
  });

  it("preserves own JSON keys without changing the copied object's prototype", () => {
    const value = JSON.parse('{"__proto__":{"message":"test-secret"},"constructor":"test-secret"}');
    const copy = maskDiagnosticCopy(value, ["test-secret"]);
    expect(Object.getPrototypeOf(copy)).toBe(Object.prototype);
    expect(Object.hasOwn(copy, "__proto__")).toBe(true);
    expect(JSON.stringify(copy)).toBe('{"__proto__":{"message":"[REDACTED]"},"constructor":"[REDACTED]"}');
    expect(value.__proto__.message).toBe("test-secret");
  });

  it("copies native DOMException diagnostic slots and graph links without mutating the cause", () => {
    const cause = new DOMException("fetch aborted test-secret", "AbortError");
    const body = { credential: "test-secret" };
    Object.defineProperties(cause, {
      body: { value: body, enumerable: false },
      cause: { value: cause, enumerable: false },
    });
    const value = { cause, same: cause, body };
    const copy = maskDiagnosticCopy(value, ["test-secret"]);
    expect(copy.cause).toBeInstanceOf(DOMException);
    expect(Object.getPrototypeOf(copy.cause)).toBe(Object.getPrototypeOf(cause));
    expect(copy.cause.name).toBe("AbortError");
    expect(copy.cause.message).toBe("fetch aborted [REDACTED]");
    expect(copy.cause.code).toBe(DOMException.ABORT_ERR);
    expect(String(copy.cause)).toBe("AbortError: fetch aborted [REDACTED]");
    expect(copy.cause.stack).toContain("fetch aborted [REDACTED]");
    expect(copy.cause.stack).not.toContain("test-secret");
    expect(copy.same).toBe(copy.cause);
    expect(copy.cause).toMatchObject({ cause: copy.cause, body: copy.body });
    expect(Object.getOwnPropertyDescriptor(copy.cause, "body")?.enumerable).toBe(false);
    expect(copy.body).toEqual({ credential: "[REDACTED]" });
    expect(cause.message).toBe("fetch aborted test-secret");
    expect(cause.name).toBe("AbortError");
    expect(cause.code).toBe(DOMException.ABORT_ERR);
    expect(cause.stack).toContain("test-secret");
    expect(body.credential).toBe("test-secret");
  });
});
