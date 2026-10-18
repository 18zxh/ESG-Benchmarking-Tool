import type { ModuleId } from "./types";
export const moduleLabels: Record<ModuleId, string> = {
  csa: "CSA",
  msci: "MSCI",
  mainland: "大陆交易所",
  hkex: "港交所",
  benchmark: "横向对标",
};
const entries: Record<ModuleId, [string, string, string]> = {
  csa: ["/csa/", "#/questions", "#/workbench"],
  msci: ["/msci/", "#/issues", "#/workbench"],
  mainland: ["/exchange/", "#/mainland/knowledge", "#/mainland/workbench"],
  hkex: ["/exchange/", "#/hk/knowledge", "#/hk/workbench"],
  benchmark: ["/exchange/", "#/benchmark", "#/benchmark"],
};
export function originalEntry(
  module: ModuleId,
  project?: string,
  workbench = false,
) {
  const [path, home, assessment] = entries[module];
  return (
    path +
    (project ? "?project=" + encodeURIComponent(project) : "") +
    (workbench ? assessment : home)
  );
}
