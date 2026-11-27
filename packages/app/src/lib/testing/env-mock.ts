// A `vi.mock` body for `$app/env/private` or `$app/env/public`: every variable `src/env.ts`
// declares, read from `values` on each access. A vitest mock throws on an export its factory did
// not return, and a variable the test leaves out must read as unset, as it does in the app.
//
//   vi.mock("$app/env/private", async () =>
//     (await import("#lib/testing/env-mock.ts")).envMock({ RYPH_PROXY_SECRET: "hop" }));
//
// Pass a function to change the values between tests.
import { variables } from "../../env.ts";

type Values = Record<string, string | undefined>;

export function envMock(values: Values | (() => Values)): Record<string, string | undefined> {
  const read = typeof values === "function" ? values : () => values;
  const mock = {};
  for (const name of Object.keys(variables)) {
    Object.defineProperty(mock, name, { enumerable: true, get: () => read()[name] });
  }
  return mock;
}
