// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RegistrationForm } from "@/components/registration-form";
import { RegistrationProvider } from "@/components/registration-provider";
import { operationStorageKey } from "@/lib/operation-id";
import type { Athlete } from "@/lib/registration";

type Submission = { requestId: string; athlete: Athlete; website: string };
let submissions: Submission[];
let respond: () => Response | Promise<Response>;

beforeEach(() => {
  sessionStorage.clear();
  submissions = [];
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    if (url === "/api/pix") return Response.json({ message: "Pix indisponível no teste." }, { status: 503 });
    submissions.push(JSON.parse(String(init.body)));
    const response = await respond();
    if (response.headers.get("content-type")?.includes("application/json") && response.ok) {
      const data = await response.json();
      const status = data.emailStatus === "SENT" ? "SENT" : "PENDING";
      return Response.json({
        emailDeliveries: { organization: status, athlete: status }, ...data,
      }, { status: response.status });
    }
    return response;
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function fillForm() {
  const user = userEvent.setup();
  render(createElement(RegistrationProvider, null, createElement(RegistrationForm)));
  await user.type(screen.getByLabelText("Nome completo", { exact: false }), "Atleta Teste");
  await user.type(screen.getByLabelText("Endereço", { exact: false }), "Rua de Teste, 100");
  await user.type(screen.getByLabelText("Onde treina", { exact: false }), "Arena Teste");
  await user.type(screen.getByLabelText("E-mail", { exact: false }), "atleta@example.test");
  await user.type(screen.getByLabelText("Data de nascimento", { exact: false }), "01011990");
  await user.click(screen.getByRole("checkbox", { name: /Masculino C/ }));
  return user;
}

describe("recuperação da inscrição", () => {
  it("formata telefone e nascimento ao digitar e envia email minusculo e data ISO", async () => {
    respond = () => Response.json({
      id: "protocolo", amountCents: 6000, emailStatus: "SENT", message: "PDF enviado.",
    });
    const user = await fillForm();
    const email = screen.getByLabelText<HTMLInputElement>("E-mail", { exact: false });
    const phone = screen.getByLabelText<HTMLInputElement>("Telefone (opcional)");
    const birthDate = screen.getByLabelText<HTMLInputElement>("Data de nascimento", { exact: false });
    expect(birthDate.type).toBe("text");
    expect(birthDate.value).toBe("01/01/1990");
    await user.clear(email);
    await user.type(email, "ATLETA@Example.TEST");
    expect(email.value).toBe("atleta@example.test");
    await user.type(phone, "11999991234");
    expect(phone.value).toBe("(11) 99999-1234");
    await user.click(screen.getByRole("button", { name: "Enviar inscrição" }));
    await screen.findByText("PDF enviado.");
    expect(submissions[0].athlete).toMatchObject({
      email: "atleta@example.test", phone: "(11) 99999-1234", birthDate: "1990-01-01",
    });
  });

  it("formata valores colados, permite limpar telefone e reinicia os campos mascarados", async () => {
    respond = () => Response.json({
      id: "protocolo", amountCents: 6000, emailStatus: "SENT", message: "PDF enviado.",
    });
    const user = await fillForm();
    const email = screen.getByLabelText<HTMLInputElement>("E-mail", { exact: false });
    const phone = screen.getByLabelText<HTMLInputElement>("Telefone (opcional)");
    const birthDate = screen.getByLabelText<HTMLInputElement>("Data de nascimento", { exact: false });
    await user.clear(email);
    await user.paste("COLADO@EXAMPLE.TEST");
    expect(email.value).toBe("colado@example.test");
    await user.click(phone);
    await user.paste("21987654321");
    expect(phone.value).toBe("(21) 98765-4321");
    await user.keyboard("{Control>}a{/Control}{Backspace}");
    await user.tab();
    expect(phone.value).toBe("");
    await user.clear(birthDate);
    await user.paste("29/02/2000");
    expect(birthDate.value).toBe("29/02/2000");
    await user.click(screen.getByRole("button", { name: "Enviar inscrição" }));
    await screen.findByText("PDF enviado.");
    expect(submissions[0].athlete).toMatchObject({
      email: "colado@example.test", phone: "", birthDate: "2000-02-29",
    });
    await user.click(screen.getByRole("button", { name: "Cadastrar outro atleta" }));
    expect(birthDate.value).toBe("");
    expect(phone.value).toBe("");
    await user.type(birthDate, "31121995");
    expect(birthDate.value).toBe("31/12/1995");
    await user.type(phone, "11912345678");
    expect(phone.value).toBe("(11) 91234-5678");
  });

  it.each(["0101", "31122999", "31121899", "31022000"])(
    "nao envia nascimento incompleto ou invalido digitado como %s",
    async (value) => {
      const user = await fillForm();
      const birthDate = screen.getByLabelText<HTMLInputElement>("Data de nascimento", { exact: false });
      await user.clear(birthDate);
      await user.type(birthDate, value);
      await user.click(screen.getByRole("button", { name: "Enviar inscrição" }));
      await waitFor(() => expect(birthDate.getAttribute("aria-invalid")).toBe("true"));
      expect(submissions).toHaveLength(0);
    },
  );

  it("mostra falha parcial, mantém os dados e permite reenviar pelo mesmo protocolo", async () => {
    respond = () => Response.json({
      id: "protocolo", amountCents: 6000, emailStatus: "FAILED",
      emailDeliveries: { organization: "SENT", athlete: "PENDING" },
      message: "A cópia para você ainda não foi confirmada.",
    }, { status: 202 });
    const user = await fillForm();
    await user.click(screen.getByRole("button", { name: "Enviar inscrição" }));
    await screen.findByText("A cópia para você ainda não foi confirmada.");
    expect(screen.getByText(/PDF para a organização: envio confirmado.*PDF para você: envio pendente/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Cadastrar outro atleta" })).toBeNull();
    respond = () => Response.json({
      id: "protocolo", amountCents: 6000, emailStatus: "SENT", message: "Ambos confirmados.",
    });
    await user.click(screen.getByRole("button", { name: "Tentar envio novamente" }));
    await screen.findByText("Ambos confirmados.");
    expect(submissions[1]).toEqual(submissions[0]);
    expect(screen.getByText(/PDF para a organização: envio confirmado.*PDF para você: envio confirmado/)).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Inscrição registrada" }).disabled).toBe(true);
  });
  it("exibe um parceiro por categoria e remove somente o valor da categoria desmarcada", async () => {
    respond = () => Response.json({
      id: "protocolo", amountCents: 10000, emailStatus: "SENT", message: "PDF enviado.",
    });
    const user = await fillForm();
    const firstCheckbox = screen.getByRole("checkbox", { name: /Masculino C/ });
    const secondCheckbox = screen.getByRole("checkbox", { name: /Masculino B/ });
    expect(screen.queryByLabelText(/Nome do parceiro.*Masculino B/)).toBeNull();
    const first = screen.getByLabelText<HTMLInputElement>(/Nome do parceiro.*Masculino C/);
    expect(first.required).toBe(false);
    await user.type(first, "Parceiro Primeiro");
    await user.click(secondCheckbox);
    await user.type(screen.getByLabelText(/Nome do parceiro.*Masculino B/), "Parceiro Segundo");
    await user.click(firstCheckbox);
    expect(screen.queryByLabelText(/Nome do parceiro.*Masculino C/)).toBeNull();
    expect(screen.getByLabelText<HTMLInputElement>(/Nome do parceiro.*Masculino B/).value).toBe("Parceiro Segundo");
    await user.click(firstCheckbox);
    expect(screen.getByLabelText<HTMLInputElement>(/Nome do parceiro.*Masculino C/).value).toBe("");
    await user.type(screen.getByLabelText(/Nome do parceiro.*Masculino C/), "Parceiro Novo");
    await user.click(screen.getByRole("button", { name: "Enviar inscrição" }));
    await screen.findByText("PDF enviado.");
    expect(submissions[0].athlete.partners).toEqual([
      { categoryId: "masculino-b", player1Id: "Parceiro Segundo" },
      { categoryId: "masculino-c", player1Id: "Parceiro Novo" },
    ]);
    expect(firstCheckbox.closest("fieldset")?.disabled).toBe(true);
    await user.click(screen.getByRole("button", { name: "Cadastrar outro atleta" }));
    expect(screen.queryByLabelText(/Nome do parceiro/)).toBeNull();
    await user.click(firstCheckbox);
    expect(screen.getByLabelText<HTMLInputElement>(/Nome do parceiro.*Masculino C/).value).toBe("");
  });

  it("associa erros de nome ao input e não envia dados inválidos", async () => {
    const user = await fillForm();
    const partner = screen.getByLabelText<HTMLInputElement>(/Nome do parceiro.*Masculino C/);
    await user.type(partner, "Parceiro");
    await user.click(screen.getByRole("button", { name: "Enviar inscrição" }));
    await screen.findByText("Informe nome e sobrenome do parceiro.");
    expect(partner.getAttribute("aria-invalid")).toBe("true");
    expect(partner.getAttribute("aria-describedby")).toBe("partner-masculino-c-error");
    expect(submissions).toHaveLength(0);
  });

  it("permite telefone opcional e envia o valor informado", async () => {
    respond = () => Response.json({
      id: "protocolo", amountCents: 6000, emailStatus: "SENT", message: "PDF enviado.",
    });
    const user = await fillForm();
    const phone = screen.getByLabelText<HTMLInputElement>("Telefone (opcional)");
    expect(phone.type).toBe("tel");
    expect(phone.required).toBe(false);
    await user.type(phone, "(11) 99999-1234");
    await user.click(screen.getByRole("button", { name: "Enviar inscrição" }));
    await screen.findByText("PDF enviado.");
    expect(submissions[0].athlete.phone).toBe("(11) 99999-1234");
  });

  it.each([400, 409])("permite corrigir HTTP %s sem trocar o protocolo", async (status) => {
    respond = () => Response.json({ message: "Reenvie os dados originais." }, { status });
    const user = await fillForm();
    await user.click(screen.getByRole("button", { name: "Enviar inscrição" }));
    await screen.findByText("Reenvie os dados originais.");
    const name = screen.getByLabelText<HTMLInputElement>("Nome completo", { exact: false });
    expect(name.disabled).toBe(false);
    expect(name.closest("fieldset")?.disabled).toBe(false);
    await user.clear(name);
    await user.type(name, "Atleta Original");
    respond = () => Response.json({ id: "protocolo", amountCents: 6000, emailStatus: "SENT", message: "PDF enviado." });
    await user.click(screen.getByRole("button", { name: "Enviar inscrição" }));
    await screen.findByText("PDF enviado.");
    expect(submissions).toHaveLength(2);
    expect(submissions[1].requestId).toBe(submissions[0].requestId);
    expect(submissions[1].athlete.fullName).toBe("Atleta Original");
    expect(sessionStorage.getItem(operationStorageKey)).toBe(submissions[0].requestId);
    await user.click(screen.getByRole("button", { name: "Cadastrar outro atleta" }));
    expect(sessionStorage.getItem(operationStorageKey)).toBeNull();
    expect(name.value).toBe("");
    expect(name.closest("fieldset")?.disabled).toBe(false);
    expect(screen.getByRole("checkbox", { name: /Masculino C/ }).getAttribute("data-state")).toBe("unchecked");
  });

  it.each(["network", "invalid", "429", "500"])("preserva snapshot e protocolo após %s", async (failure) => {
    respond = () => {
      if (failure === "network") throw new TypeError("Failed to fetch");
      if (failure === "invalid") return new Response("{");
      return Response.json({ message: "Servidor indisponível." }, { status: Number(failure) });
    };
    const user = await fillForm();
    await user.type(screen.getByLabelText(/Nome do parceiro.*Masculino C/), "Parceiro Preservado");
    await user.click(screen.getByRole("button", { name: "Enviar inscrição" }));
    await waitFor(() => expect(screen.getByRole<HTMLButtonElement>("button", { name: "Tentar envio novamente" }).disabled).toBe(false));
    const name = screen.getByLabelText<HTMLInputElement>("Nome completo", { exact: false });
    expect(name.closest("fieldset")?.disabled).toBe(true);
    respond = () => Response.json({ id: "protocolo", amountCents: 6000, emailStatus: "FAILED", message: "Falha ao enviar PDF." });
    await user.click(screen.getByRole("button", { name: "Tentar envio novamente" }));
    await screen.findByText("Falha ao enviar PDF.");
    expect(submissions[1]).toEqual(submissions[0]);
    expect(submissions[1].athlete.partners[0].player1Id).toBe("Parceiro Preservado");
    respond = () => Response.json({ id: "protocolo", amountCents: 6000, emailStatus: "SENT", message: "PDF enviado." });
    await user.click(screen.getByRole("button", { name: "Tentar envio novamente" }));
    await screen.findByText("PDF enviado.");
    expect(submissions[2]).toEqual(submissions[0]);
  });
});
