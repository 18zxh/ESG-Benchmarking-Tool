import { peerChecks } from "./peer.ts";
import { buildXlsx, downloadXlsx } from "../../modules/exchange/site/xlsx.js";
import type { Project, Run, Method, Criterion } from "./types";
const text = (value: unknown): string =>
  Array.isArray(value)
    ? value.map(text).join("\n")
    : typeof value === "string"
      ? value
      : JSON.stringify(value ?? "");
const chunks = (value: string) => {
  const out = [];
  for (let i = 0; i < value.length; i += 28000)
    out.push(value.slice(i, i + 28000));
  return out.length ? out : [""];
};
export function projectSheets(
  project: Project,
  run: Run | undefined,
  method: Method | undefined,
  criteria: Criterion[],
) {
  const actual = run?.results || [];
  const rows =
    project.module === "benchmark"
      ? actual
      : [
          ...actual,
          ...project.selected
            .filter((id) => !actual.some((r) => r.id === id))
            .map((id) => ({
              id,
              title: criteria.find((c) => c.id === id)?.title || id,
              status: "未处理",
              disclosure: "",
              gap: "",
              suggestion: "",
              evidence: [],
              raw: {},
              company: project.company,
            })),
        ];
  const overview = [
    ["字段", "内容"],
    ["项目", project.name],
    ["企业", project.company],
    ["模块", project.module],
    ["报告覆盖期间", project.reportPeriod],
    ["目标披露期间", project.targetPeriod],
    ["方法版本", method?.version || ""],
    ["方法指纹", method?.hash || ""],
    ["任务状态", run?.status || "未处理"],
    ["旧结果过期", project.stale ? "是" : "否"],
    ["适用条件", JSON.stringify(project.options)],
  ];
  const results = [
    [
      "指标ID",
      "指标",
      "公司",
      "处理状态",
      "已有披露",
      "披露不足",
      "改进建议",
      "人工评论",
    ],
    ...rows.map((r) => [
      r.id,
      r.title,
      r.company || project.company,
      r.status,
      text(r.disclosure),
      text(r.gap),
      text(r.suggestion),
      project.comments[r.id] || "",
    ]),
  ];
  const evidence = [
    ["指标ID", "文件身份", "PDF物理页", "原文"],
    ...rows.flatMap((r) =>
      r.evidence.flatMap((e) =>
        chunks(e.quote).map((q) => [r.id, e.documentId, e.page, q]),
      ),
    ),
  ];
  const methodRows = [
    ["指标ID", "标题", "分组", "完整问题/要求", "详细说明", "来源", "来源页"],
    ...criteria.flatMap((c) => {
      const req = chunks(c.requirement),
        detail = chunks(c.detail);
      return Array.from(
        { length: Math.max(req.length, detail.length) },
        (_, i) => [
          c.id,
          c.title,
          c.group,
          req[i] || "",
          detail[i] || "",
          c.source,
          c.page || "",
        ],
      );
    }),
  ];
  const raw = [
    ["类型", "身份", "分段", "完整内容"],
    ...rows.flatMap((r) =>
      chunks(JSON.stringify(r.raw)).map((v, i) => ["原始初评", r.id, i + 1, v]),
    ),
    ...chunks(JSON.stringify(method?.payload || {})).map((v, i) => [
      "完整方法包",
      method?.id || "",
      i + 1,
      v,
    ]),
  ];
  const sheets: any[] = [
    { name: "项目概况", rows: overview },
    { name: "评估与人工评论", rows: results },
    { name: "原文证据", rows: evidence },
    { name: "AI评级依据", rows: methodRows },
    { name: "完整方法与原始结果", rows: raw },
  ];
  if (project.module === "benchmark") {
    const companies = project.documents;
    const keys = peerChecks(method, rows);
    sheets.push({
      name: "同业披露矩阵",
      rows: [
        [
          "检查项",
          ...companies.map((d) => d.company || d.id),
          "同业Yes",
          "已核对同业",
          "同业总数",
          "覆盖率",
        ],
        ...keys.map(({ key, title }: { key: string; title: string }) => {
          const found = companies.map((d) =>
            rows.find((r) => r.id === d.id + "::" + key),
          );
          const peers = found.filter(
            (r, i) =>
              !companies[i].isOwn && r && ["Yes", "N"].includes(r.status),
          );
          const yes = peers.filter((r) => r?.status === "Yes").length;
          return [
            title,
            ...found.map((r) =>
              r?.status === "Yes" || r?.status === "N" ? r.status : "",
            ),
            yes,
            peers.length,
            companies.filter((d) => !d.isOwn).length,
            peers.length ? yes / peers.length : "",
          ];
        }),
      ],
    });
  }
  return sheets;
}

export function exportProject(
  project: Project,
  run: Run | undefined,
  method: Method | undefined,
  criteria: Criterion[],
) {
  if (
    project.stale ||
    (run && run.id !== project.lastRunId) ||
    method?.id !== project.methodId
  )
    throw new Error("请使用当前输入对应的最新评估与方法版本导出。");
  downloadXlsx(
    project.name + "-评估与复核.xlsx",
    buildXlsx(projectSheets(project, run, method, criteria)),
  );
}
