import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";

/**
 * Painel VS BY CLOSET — base do admin de aluguéis.
 *
 * Por enquanto só confirma que o app instalou e autenticou na loja certa.
 * As reservas ainda não aparecem aqui porque quem guarda reserva é o
 * reservations-api (banco central, compartilhado entre a loja BR e a CL) —
 * este painel vai ler de lá, não do banco da Shopify. A Shopify não sabe o
 * que é "retirada dia 10, devolução dia 15, atrasou 2 dias"; pra ela todo
 * pedido é uma venda comum.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  return { shop: session.shop };
};

export default function Index() {
  return (
    <s-page heading="VS BY CLOSET — Aluguel">
      <s-section heading="Sistema conectado">
        <s-paragraph>
          O app está instalado e autenticado nesta loja.
        </s-paragraph>
        <s-paragraph>
          As reservas aparecem aqui assim que o painel for ligado ao banco
          central. Enquanto isso, este espaço fica intencionalmente vazio —
          preferimos nada a número inventado.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

// A Shopify precisa que o React Router capture certas respostas lançadas,
// pra que os headers dela venham junto.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
