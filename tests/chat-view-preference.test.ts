import { describe, expect, test } from "bun:test";

const preference = await import("../src/view-preference").catch(() => ({} as any));

describe("preferencia de vista del chat", () => {
  test("define exactamente las tres vistas y Conversacion como valor inicial", () => {
    expect(preference.CHAT_VIEWS).toEqual(["conversation", "evidence", "activity"]);
    expect(preference.DEFAULT_CHAT_VIEW).toBe("conversation");
  });

  test("usa el valor inicial cuando no hay preferencia o el valor guardado es desconocido", () => {
    expect(preference.readChatViewPreference({ getItem: () => null })).toBe("conversation");
    expect(preference.readChatViewPreference({ getItem: () => "future-view" })).toBe("conversation");
  });

  test("usa el valor inicial si el almacenamiento no esta disponible", () => {
    expect(preference.readChatViewPreference(null)).toBe("conversation");
    expect(preference.readChatViewPreference({ getItem: () => { throw new Error("storage unavailable"); } })).toBe("conversation");
  });

  test("acepta los tres nombres reconocidos sin alterarlos", () => {
    for (const view of ["conversation", "evidence", "activity"]) {
      expect(preference.readChatViewPreference({ getItem: () => view })).toBe(view);
    }
  });
});
