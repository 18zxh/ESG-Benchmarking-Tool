import { lazy, Suspense, useEffect, useState } from "react";
import { Save, Download, Upload, ArrowRight } from "lucide-react";
import { api, upload, downloadJson } from "./api";
import { Button, Empty, Field, Notice, Status } from "./ui";
import { SchemaForm } from "./SchemaForm";
import { scopeSchema } from "./schema";
import { MappingEditor } from "./MappingEditor";
import { BenchmarkMatrix } from "./BenchmarkMatrix";
import { exportProject } from "./export";
import type {
  Common,
  Project,
  Method,
  Criterion,
  Run,
  Result,
  DocumentRef,
} from "./types";
const PdfPane = lazy(() => import("./PdfPane"));
const names: Record<string, string> = {
  csa: "CSA",
  msci: "MSCI",
  mainland: "大陆交易所",
  hkex: "港交所",
  benchmark: "横向对标",
};
const text = (v: unknown): string =>
  Array.isArray(v)
    ? v.map(text).join("\n")
    : typeof v === "string"
      ? v
      : JSON.stringify(v ?? "");
function catalogKey(p: Project) {
  return (
    p.module +
    ":" +
    (p.module === "csa"
      ? p.options.industry || ""
      : p.module === "mainland"
        ? p.options.exchange || ""
        : p.module === "hkex"
          ? (p.options.issuerCategory || "") +
            ":" +
            (p.options.fiscalYearStart || "")
          : "")
  );
}
export default function Workbench({
  id,
  boot,
  refresh,
  report,
  fail,
  onDirty,
}: Common & { id: string; onDirty: (v: boolean) => void }) {
  const [p, setP] = useState<Project>(),
    [method, setMethod] = useState<Method>(),
    [rows, setRows] = useState<Criterion[]>([]),
    [run, setRun] = useState<Run>(),
    [step, setStep] = useState(1),
    [busy, setBusy] = useState(false),
    [dirty, setDirty] = useState(false),
    [query, setQuery] = useState(""),
    [current, setCurrent] = useState(""),
    [preview, setPreview] = useState<{ id: string; page: number }>(),
    [tab, setTab] = useState<"workbench" | "knowledge">("workbench");
  const loadMethod = async (key: string) => {
    const v = await api<{ method: Method; criteria: Criterion[] }>(
      "/methods/" + key,
    );
    setMethod(v.method);
    setRows(v.criteria);
  };
  useEffect(() => {
    api<Project>("/projects/" + id)
      .then(async (value) => {
        setP(value);
        if (value.methodId) await loadMethod(value.methodId);
        if (value.lastRunId) {
          setRun(await api<Run>("/runs/" + value.lastRunId));
          setStep(3);
        }
      })
      .catch(fail);
  }, [id]);
  useEffect(() => {
    onDirty(dirty);
    return () => onDirty(false);
  }, [dirty, onDirty]);
  const active = !!run && ["queued", "running", "paused"].includes(run.status);
  useEffect(() => {
    if (!run || !active) return;
    const timer = setInterval(
      () =>
        api<Run>("/runs/" + run.id)
          .then(setRun)
          .catch(fail),
      1000,
    );
    return () => clearInterval(timer);
  }, [run?.id, active]);
  const update = (changes: Partial<Project>) => {
    setP((value) => (value ? { ...value, ...changes } : value));
    setDirty(true);
  };
  const save = async () => {
    if (!p) throw new Error("项目尚未加载。");
    const saved = await api<Project>("/projects/" + id, p);
    setP(saved);
    setDirty(false);
    await refresh();
    return saved;
  };
  const perform = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  if (!p) return <p role="status">正在读取项目…</p>;
  const currentPackage =
    !!method && method.catalogKey === catalogKey(p) && method.id === p.methodId;
  const canRun =
    !!p.methodId &&
    currentPackage &&
    p.documents.length > 0 &&
    p.selected.length > 0 &&
    boot.providers.length > 0 &&
    !busy &&
    !active;
  const sourceRows = run?.results || [];
  const result = sourceRows.find((r) => r.id === current) || sourceRows[0];
  const loadScope = async () => {
    const value = await api<{ method: Method; criteria: Criterion[] }>(
      "/catalog?module=" +
        p.module +
        "&options=" +
        encodeURIComponent(JSON.stringify(p.options)),
    );
    setMethod(value.method);
    setRows(value.criteria);
    const selected =
      p.module === "msci"
        ? value.method.payload.criteria
            .filter((c: any) => c.criterion.pillar === "governance")
            .map((c: any) => c.id)
        : p.module === "mainland"
          ? value.criteria.filter((c) => c.default).map((c) => c.id)
          : value.criteria.map((c) => c.id);
    update({ methodId: value.method.id, selected });
    report("已载入完整方法。请核对检查范围后保存。");
  };
  const start = async (retry: boolean) => {
    await save();
    const created = await api<Run>("/runs", { projectId: id, retry });
    setRun(created);
    setP(await api<Project>("/projects/" + id));
    setStep(2);
    report("已创建任务；成功页段与结果会保存为本次评估记录。");
  };
  const chooseDocument = (ref: DocumentRef, checked: boolean) => {
    update({
      documents: checked
        ? [...p.documents, ref]
        : p.documents.filter((d) => d.id !== ref.id),
    });
  };
  const addFiles = async (files: FileList | null) => {
    if (!files) return;
    const chosen = [...p.documents];
    for (const f of Array.from(files)) {
      const value = await upload(f);
      chosen.push({ id: value.id, company: p.company, period: p.reportPeriod });
    }
    update({ documents: chosen });
    await refresh();
  };
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="breadcrumb">
            <a href={"#/module/" + p.module}>{names[p.module]}</a>
            <span>/</span>
            <span>{p.name}</span>
          </div>
          <h1>{p.name}</h1>
          <p>
            {p.company || "多公司对标"}
            {p.reportPeriod ? " · " + p.reportPeriod : ""} ·{" "}
            {dirty ? "有未保存修改" : "已保存到本机"}
          </p>
        </div>
        <div className="actions">
          <Button
            variant="outline"
            disabled={busy}
            onClick={() =>
              void perform(async () => {
                await save();
                report("项目、独立评论与当前方法版本已保存。");
              })
            }
          >
            <Save size={16} />
            保存项目
          </Button>
          <Button
            variant="outline"
            disabled={
              busy ||
              dirty ||
              p.stale ||
              !currentPackage ||
              active ||
              (!!run && run.id !== p.lastRunId)
            }
            onClick={() => exportProject(p, run, method, rows)}
          >
            <Download size={16} />
            导出 Excel
          </Button>
        </div>
      </div>
      {p.stale ? (
        <Notice>
          评估输入或资料信息已改变，旧结果保留为历史。请保存并重新初评后导出。
        </Notice>
      ) : null}
      <div className="module-tabs">
        <button
          onClick={() => setTab("workbench")}
          aria-current={tab === "workbench" ? "page" : undefined}
        >
          工作台
        </button>
        <button
          onClick={() => setTab("knowledge")}
          aria-current={tab === "knowledge" ? "page" : undefined}
        >
          知识库与方法
        </button>
      </div>
      {tab === "knowledge" ? (
        <section className="section">
          <h2>当前项目的方法依据</h2>
          {method ? (
            <>
              <p>
                {method.version} · <Status value={method.status} />
              </p>
              <p className="muted">{method.sourceNote}</p>
              <input
                aria-label="检索方法要求"
                placeholder="按指标、分组或关键词检索"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              {rows
                .filter((c) =>
                  [c.title, c.group, c.requirement].join(" ").includes(query),
                )
                .map((c) => (
                  <details key={c.id} className="method-detail">
                    <summary>
                      {c.group} · {c.title}
                    </summary>
                    <p className="preserve">{c.requirement}</p>
                    <p className="preserve">{c.detail}</p>
                    <p className="muted">
                      {c.source}
                      {c.page ? " · 物理页 " + c.page : ""}
                    </p>
                  </details>
                ))}
              <details>
                <summary>查看完整方法包与适用条件</summary>
                <pre>{JSON.stringify(method.payload, null, 2)}</pre>
              </details>
            </>
          ) : (
            <p>先在上传与范围中载入适用方法。</p>
          )}
        </section>
      ) : (
        <>
          <nav className="steps" aria-label="评估步骤">
            {["上传与范围", "AI 初评", "人工复核"].map((label, i) => (
              <button
                key={label}
                aria-current={step === i + 1 ? "step" : undefined}
                onClick={() => setStep(i + 1)}
              >
                <span>{i + 1}</span>
                {label}
              </button>
            ))}
          </nav>
          {step === 1 ? (
            <>
              <fieldset disabled={active || busy} className="section">
                <h2>项目与适用范围</h2>
                <div className="form-grid">
                  <Field label="项目名称">
                    <input
                      value={p.name}
                      onChange={(e) => update({ name: e.target.value })}
                    />
                  </Field>
                  <Field label="企业名称">
                    <input
                      value={p.company}
                      onChange={(e) => update({ company: e.target.value })}
                      placeholder={
                        p.module === "benchmark"
                          ? "对标项目可在各报告中分别填写"
                          : "输入评估企业"
                      }
                    />
                  </Field>
                  <Field
                    label={
                      ["mainland", "hkex"].includes(p.module)
                        ? "报告覆盖年度"
                        : "报告实际覆盖期间"
                    }
                  >
                    <input
                      value={p.reportPeriod}
                      onChange={(e) => update({ reportPeriod: e.target.value })}
                      placeholder="按报告原文填写"
                    />
                  </Field>
                  <Field label="目标披露期间／年度">
                    <input
                      value={p.targetPeriod}
                      onChange={(e) => update({ targetPeriod: e.target.value })}
                    />
                  </Field>
                </div>
                <SchemaForm
                  schema={scopeSchema(p.module, boot)}
                  value={p.options}
                  onChange={(options) => update({ options })}
                />
                {p.module === "hkex" ? (
                  <p className="muted">
                    大型股类别需核实上一财年全年成分股条件及已进入强制要求的历史；财年按开始日期判断。
                  </p>
                ) : null}
                <div className="actions">
                  <Button
                    variant="outline"
                    onClick={() => void perform(loadScope)}
                  >
                    载入适用方法与检查范围
                  </Button>
                  {method ? (
                    <span className="muted">
                      {currentPackage
                        ? method.version
                        : "适用条件已改变，请重新载入方法"}
                    </span>
                  ) : null}
                </div>
              </fieldset>
              <section className="section">
                <div className="section-heading">
                  <div>
                    <h2>
                      {p.module === "benchmark" ? "公司与报告" : "选择报告资料"}
                    </h2>
                    <p className="muted">
                      首份为主报告，其余为补充资料。资料类型与覆盖期间在资料库中维护。
                    </p>
                  </div>
                  <label className="button button-outline file-button">
                    <Upload size={16} />
                    添加 PDF
                    <input
                      type="file"
                      aria-label="添加项目 PDF"
                      multiple
                      accept="application/pdf,.pdf"
                      disabled={active || busy}
                      onChange={(e) =>
                        void perform(() => addFiles(e.target.files))
                      }
                    />
                  </label>
                </div>
                {!boot.documents.length ? (
                  <p>资料库为空。添加 PDF 后即可在本项目使用。</p>
                ) : (
                  boot.documents.map((doc) => {
                    const ref = p.documents.find((d) => d.id === doc.id);
                    return (
                      <div className="document-row" key={doc.id}>
                        <label className="check">
                          <input
                            type="checkbox"
                            disabled={active || busy}
                            checked={!!ref}
                            onChange={(e) =>
                              chooseDocument(
                                {
                                  id: doc.id,
                                  company: doc.meta.company || p.company,
                                  period: doc.meta.period || p.reportPeriod,
                                },
                                e.target.checked,
                              )
                            }
                          />
                          <span>
                            <strong>{doc.name}</strong>
                            <small>
                              {doc.pageCount} 页 ·{" "}
                              {doc.meta.period || "覆盖期间待确认"} ·{" "}
                              {ref && p.documents[0].id === ref.id
                                ? "主报告"
                                : "资料库原件"}
                            </small>
                          </span>
                        </label>
                        <Button
                          variant="ghost"
                          onClick={() => setPreview({ id: doc.id, page: 1 })}
                        >
                          查看原页
                        </Button>
                        {ref &&
                        p.module !== "benchmark" &&
                        p.documents[0].id !== ref.id ? (
                          <Button
                            variant="ghost"
                            disabled={active}
                            onClick={() =>
                              update({
                                documents: [
                                  ref,
                                  ...p.documents.filter((d) => d.id !== ref.id),
                                ],
                              })
                            }
                          >
                            设为主报告
                          </Button>
                        ) : null}
                        {ref && p.module === "benchmark" ? (
                          <div className="peer-fields">
                            <Field label={doc.name + " 对应公司"}>
                              <input
                                value={ref.company || ""}
                                onChange={(e) =>
                                  update({
                                    documents: p.documents.map((d) =>
                                      d.id === ref.id
                                        ? { ...d, company: e.target.value }
                                        : d,
                                    ),
                                  })
                                }
                              />
                            </Field>
                            <Field label={doc.name + " 覆盖年度"}>
                              <input
                                value={ref.period || ""}
                                onChange={(e) =>
                                  update({
                                    documents: p.documents.map((d) =>
                                      d.id === ref.id
                                        ? { ...d, period: e.target.value }
                                        : d,
                                    ),
                                  })
                                }
                              />
                            </Field>
                            <label className="check">
                              <input
                                type="checkbox"
                                checked={!!ref.isOwn}
                                onChange={(e) =>
                                  update({
                                    documents: p.documents.map((d) => ({
                                      ...d,
                                      isOwn:
                                        d.id === ref.id
                                          ? e.target.checked
                                          : false,
                                    })),
                                  })
                                }
                              />
                              本公司
                            </label>
                          </div>
                        ) : null}
                      </div>
                    );
                  })
                )}
                <a href="#/library">
                  维护资料类型、期间和公开来源 <ArrowRight size={14} />
                </a>
              </section>
              <section className="section">
                <div className="section-heading">
                  <h2>检查范围</h2>
                  <span className="muted">
                    已选 {p.selected.length} / {rows.length}
                  </span>
                </div>
                {rows.length ? (
                  <>
                    <div className="toolbar">
                      <input
                        aria-label="搜索检查项"
                        placeholder="搜索指标或分组"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                      />
                      <Button
                        variant="ghost"
                        disabled={active || p.module === "benchmark"}
                        onClick={() =>
                          update({ selected: rows.map((c) => c.id) })
                        }
                      >
                        全选
                      </Button>
                      <Button
                        variant="ghost"
                        disabled={active || p.module === "benchmark"}
                        onClick={() => update({ selected: [] })}
                      >
                        清空
                      </Button>
                    </div>
                    <div className="scope-list">
                      {rows
                        .filter((c) =>
                          [c.title, c.group].join(" ").includes(query),
                        )
                        .map((c) => (
                          <label className="check scope-item" key={c.id}>
                            <input
                              type="checkbox"
                              disabled={active || p.module === "benchmark"}
                              checked={p.selected.includes(c.id)}
                              onChange={(e) =>
                                update({
                                  selected: e.target.checked
                                    ? [...p.selected, c.id]
                                    : p.selected.filter((i) => i !== c.id),
                                })
                              }
                            />
                            <span>
                              {c.title}
                              <small>
                                {c.group} · {c.id}
                              </small>
                            </span>
                          </label>
                        ))}
                    </div>
                    {p.module === "benchmark" ? (
                      <p className="muted">
                        对标按完整21议题×11检查项执行，同业覆盖率排除本公司，失败或未完成保持空白。
                      </p>
                    ) : null}
                  </>
                ) : (
                  <p>填写适用条件后，点击“载入适用方法与检查范围”。</p>
                )}
              </section>
              <div className="stage-actions">
                <Button
                  disabled={!canRun}
                  onClick={() => void perform(() => start(false))}
                >
                  保存并开始 AI 初评 <ArrowRight size={16} />
                </Button>
                <span className="muted">
                  {!boot.providers.length
                    ? "请先在设置中连接模型。"
                    : "模型会读取所选原PDF，自动初评须人工核对。"}
                </span>
              </div>
            </>
          ) : step === 2 ? (
            <section className="section">
              <div className="section-heading">
                <h2>AI 初评</h2>
                {run ? <Status value={run.status} /> : null}
              </div>
              {run ? (
                <>
                  <p>{run.phase}</p>
                  <p>
                    已检查物理页 {run.processedPages} /{" "}
                    {run.totalPages || "待登记"} · 已有结果 {run.results.length}{" "}
                    项
                  </p>
                  <progress
                    aria-label="报告读取进度"
                    max={run.totalPages || 1}
                    value={Math.min(run.processedPages, run.totalPages || 1)}
                  />
                  {run.errors.length ? (
                    <div className="error">
                      {run.errors.map((e, i) => (
                        <p key={i}>{text(e)}</p>
                      ))}
                    </div>
                  ) : null}
                  <p className="muted">
                    任务只记录服务实际返回的用量。未响应的请求不能推定为零费用。
                  </p>
                  <details>
                    <summary>本次上游用量</summary>
                    <pre>{JSON.stringify(run.usage || {}, null, 2)}</pre>
                  </details>
                  <div className="actions">
                    {active ? (
                      <>
                        <Button
                          variant="outline"
                          onClick={() =>
                            void perform(async () =>
                              setRun(
                                await api("/runs/" + run.id, {
                                  action:
                                    run.status === "paused"
                                      ? "resume"
                                      : "pause",
                                }),
                              ),
                            )
                          }
                        >
                          {run.status === "paused" ? "继续" : "暂停后续调用"}
                        </Button>
                        <Button
                          variant="danger"
                          onClick={() =>
                            void perform(async () =>
                              setRun(
                                await api("/runs/" + run.id, {
                                  action: "stop",
                                }),
                              ),
                            )
                          }
                        >
                          停止后续调用
                        </Button>
                      </>
                    ) : (
                      <Button
                        variant="outline"
                        disabled={!canRun}
                        onClick={() => void perform(() => start(true))}
                      >
                        继续未完成项
                      </Button>
                    )}
                    <Button
                      disabled={!run.results.length}
                      onClick={() => setStep(3)}
                    >
                      进入人工复核
                    </Button>
                  </div>
                </>
              ) : (
                <Empty title="尚未开始初评">
                  <p>先选择报告、核对适用条件与检查范围，再开始 AI 初评。</p>
                  <Button variant="outline" onClick={() => setStep(1)}>
                    返回上传与范围
                  </Button>
                </Empty>
              )}
            </section>
          ) : (
            <section className="section">
              <div className="section-heading">
                <h2>人工复核</h2>
                {p.runIds?.length ? (
                  <select
                    aria-label="查看历史评估"
                    value={run?.id || ""}
                    onChange={(e) =>
                      void perform(async () => {
                        const historical = await api<Run>(
                          "/runs/" + e.target.value,
                        );
                        setRun(historical);
                        const value = await api<{
                          method: Method;
                          criteria: Criterion[];
                        }>("/methods/" + historical.methodId);
                        setMethod(value.method);
                        setRows(value.criteria);
                      })
                    }
                  >
                    {[...p.runIds].reverse().map((key, i) => (
                      <option key={key} value={key}>
                        {i === 0
                          ? "最新评估"
                          : "历史评估 " + (p.runIds!.length - i)}{" "}
                        · {key.slice(0, 8)}
                      </option>
                    ))}
                  </select>
                ) : null}
              </div>
              {run?.alignments ? (
                <MappingEditor
                  project={p}
                  run={run}
                  criteria={rows}
                  active={active}
                  onChange={(mappingOverrides) => update({ mappingOverrides })}
                />
              ) : null}
              {p.module === "benchmark" && run ? (
                <BenchmarkMatrix
                  project={p}
                  method={method}
                  results={sourceRows}
                  onSelect={setCurrent}
                />
              ) : null}
              {!result ? (
                <Empty title="暂无可复核结果">
                  <p>初评完成的项目会在此列出。读取失败不会生成未披露结论。</p>
                  <Button variant="outline" onClick={() => setStep(2)}>
                    查看任务
                  </Button>
                </Empty>
              ) : (
                <div className="review-grid">
                  <aside className="result-list" aria-label="复核指标列表">
                    {sourceRows.map((r) => (
                      <button
                        key={r.id}
                        className={r.id === result.id ? "selected" : ""}
                        onClick={() => setCurrent(r.id)}
                      >
                        <span>{r.title}</span>
                        {r.company ? <small>{r.company}</small> : null}
                        <Status value={r.status} />
                      </button>
                    ))}
                  </aside>
                  <article className="result-detail">
                    <h2>{result.title}</h2>
                    <Status value={result.status} />
                    {result.company ? <p>{result.company}</p> : null}
                    <details>
                      <summary>查看完整方法要求</summary>
                      <p className="preserve">
                        {rows.find((c) => c.id === result.id)?.requirement ||
                          rows.find((c) => result.title.startsWith(c.title))
                            ?.requirement}
                      </p>
                      <p className="preserve">
                        {rows.find((c) => c.id === result.id)?.detail}
                      </p>
                    </details>
                    <h3>已有披露</h3>
                    <p className="preserve">
                      {text(result.disclosure) || "未返回披露摘要。"}
                    </p>
                    <h3>披露不足与待核实事项</h3>
                    <p className="preserve">{text(result.gap) || "未列出。"}</p>
                    <h3>改进建议</h3>
                    <p className="preserve">
                      {text(result.suggestion) || "未列出。"}
                    </p>
                    <h3>原文证据</h3>
                    {result.evidence.length ? (
                      result.evidence.map((e, i) => (
                        <div className="evidence" key={i}>
                          <Button
                            variant="ghost"
                            onClick={() =>
                              setPreview({ id: e.documentId, page: e.page })
                            }
                          >
                            {boot.documents.find((d) => d.id === e.documentId)
                              ?.name ||
                              e.name ||
                              "报告"}{" "}
                            · PDF 第 {e.page} 页
                          </Button>
                          <p className="preserve">{e.quote}</p>
                        </div>
                      ))
                    ) : (
                      <p className="muted">
                        该项没有可用的披露引用；请结合处理状态和完整性记录核对。
                      </p>
                    )}
                    <Field label="独立复核评论">
                      <textarea
                        rows={5}
                        value={p.comments[result.id] || ""}
                        onChange={(e) =>
                          update({
                            comments: {
                              ...p.comments,
                              [result.id]: e.target.value,
                            },
                          })
                        }
                      />
                    </Field>
                    <p className="muted">
                      评论独立保存，不改写模型初评或表示采纳判断。
                    </p>
                    <Button
                      disabled={busy}
                      onClick={() =>
                        void perform(async () => {
                          await save();
                          report("独立复核评论已保存。");
                        })
                      }
                    >
                      保存评论
                    </Button>
                    <details className="raw-result">
                      <summary>查看原始结果与核验标记</summary>
                      <pre>{JSON.stringify(result.raw, null, 2)}</pre>
                    </details>
                  </article>
                </div>
              )}
            </section>
          )}
        </>
      )}
      {preview ? (
        <Suspense fallback={<p>正在加载 PDF 查看器…</p>}>
          <PdfPane
            id={preview.id}
            initialPage={preview.page}
            onClose={() => setPreview(undefined)}
          />
        </Suspense>
      ) : null}
      <details className="section">
        <summary>项目快照与原版入口</summary>
        {p.importWarnings?.map((v, i) => (
          <p key={i}>{v}</p>
        ))}
        {p.legacySnapshot ? (
          <details>
            <summary>导入前的完整旧项目快照</summary>
            <pre>{JSON.stringify(p.legacySnapshot, null, 2)}</pre>
          </details>
        ) : null}
        <div className="actions">
          <Button
            variant="outline"
            onClick={() => downloadJson(p.name + "-项目.json", p)}
          >
            下载项目 JSON
          </Button>
          <a
            href={
              p.module === "csa"
                ? "/csa/"
                : p.module === "msci"
                  ? "/msci/#/workbench"
                  : p.module === "benchmark"
                    ? "/exchange/#/benchmark"
                    : p.module === "hkex"
                      ? "/exchange/#/hk/workbench"
                      : "/exchange/#/mainland/workbench"
            }
            target="_blank"
            rel="noreferrer"
          >
            打开保留的原版页面
          </a>
        </div>
        <p className="muted">
          项目 JSON 引用本机资料库中的原件；跨电脑迁移请在设置中下载完整备份。
        </p>
      </details>
    </>
  );
}
