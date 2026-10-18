import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  FolderOpen,
  Files,
  BookOpen,
  Settings,
  Menu,
  Upload,
} from "lucide-react";
import {
  useReactTable,
  getCoreRowModel,
  flexRender,
  type ColumnDef,
} from "@tanstack/react-table";
import { api, upload } from "./api";
import type { Bootstrap, ModuleId, DocumentInfo } from "./types";
import { Button, Empty, Field, Notice } from "./ui";
import { SettingsPage } from "./Maintenance";
import { originalEntry, moduleLabels as labels } from "./entries";
import Projects from "./Projects";
const PdfPane = lazy(() => import("./PdfPane"));
const emptyBoot: Bootstrap = {
  modules: [],
  projects: [],
  documents: [],
  industries: [],
  providers: [],
};
function DataTable<T>({
  data,
  columns,
}: {
  data: T[];
  columns: ColumnDef<T, any>[];
}) {
  const table = useReactTable({
    data,
    columns,
    getCoreRowModel: getCoreRowModel(),
  });
  return (
    <div className="table-scroll">
      <table>
        <thead>
          {table.getHeaderGroups().map((g) => (
            <tr key={g.id}>
              {g.headers.map((h) => (
                <th key={h.id}>
                  {flexRender(h.column.columnDef.header, h.getContext())}
                </th>
              ))}
            </tr>
          ))}
        </thead>
        <tbody>
          {table.getRowModel().rows.map((r) => (
            <tr key={r.id}>
              {r.getVisibleCells().map((c) => (
                <td key={c.id}>
                  {flexRender(c.column.columnDef.cell, c.getContext())}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function App() {
  const [boot, setBoot] = useState<Bootstrap>(emptyBoot),
    [route, setRoute] = useState(location.hash || "#/projects"),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [menu, setMenu] = useState(false),
    [dirty, setDirty] = useState(false),
    [loading, setLoading] = useState(true);
  const routeRef = useRef(route);
  const dirtyRef = useRef(dirty);
  const sidebarRef = useRef<HTMLElement>(null);
  const mainShellRef = useRef<HTMLDivElement>(null);
  dirtyRef.current = dirty;
  const markDirty = useCallback((value: boolean) => {
    dirtyRef.current = value;
    setDirty(value);
  }, []);
  const refresh = useCallback(async () => {
    setBoot(await api<Bootstrap>("/bootstrap"));
    setLoading(false);
  }, []);
  useEffect(() => {
    refresh().catch((e) => {
      setError(e.message);
      setLoading(false);
    });
    const handler = () => {
      const next = location.hash || "#/projects";
      if (next === routeRef.current) return;
      if (
        dirtyRef.current &&
        !confirm("有未保存的修改。离开后这些修改将丢失，是否继续？")
      ) {
        location.hash = routeRef.current;
        return;
      }
      routeRef.current = next;
      setDirty(false);
      setRoute(next);
      setMenu(false);
      setNotice("");
      setError("");
    };
    addEventListener("hashchange", handler);
    return () => removeEventListener("hashchange", handler);
  }, [refresh]);
  useEffect(() => {
    const visible = () => {
      if (document.visibilityState === "visible")
        refresh().catch((e) => setError(e.message));
    };
    addEventListener("focus", visible);
    document.addEventListener("visibilitychange", visible);
    return () => {
      removeEventListener("focus", visible);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [refresh]);
  useEffect(() => {
    const narrow = matchMedia("(max-width: 960px)");
    const sidebar = sidebarRef.current;
    const shell = mainShellRef.current;
    const sync = () => {
      if (sidebar) sidebar.inert = narrow.matches && !menu;
      if (shell) shell.inert = narrow.matches && menu;
      if (!narrow.matches && menu) setMenu(false);
    };
    sync();
    if (menu && narrow.matches)
      sidebar?.querySelector<HTMLAnchorElement>("a")?.focus();
    narrow.addEventListener("change", sync);
    const key = (e: KeyboardEvent) => {
      if (!menu || !narrow.matches) return;
      const close = () => {
        setMenu(false);
        requestAnimationFrame(() =>
          document.querySelector<HTMLButtonElement>(".menu-toggle")?.focus(),
        );
      };
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      }
      if (e.key !== "Tab" || !sidebar) return;
      const items = Array.from(
        sidebar.querySelectorAll<HTMLAnchorElement>("a[href]"),
      ).filter((el) => el.getClientRects().length);
      const first = items[0],
        last = items.at(-1);
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
    };
    addEventListener("keydown", key);
    return () => {
      removeEventListener("keydown", key);
      narrow.removeEventListener("change", sync);
    };
  }, [menu]);
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (dirtyRef.current) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    addEventListener("beforeunload", handler);
    return () => removeEventListener("beforeunload", handler);
  }, []);
  const report = (message: string) => {
    setError("");
    setNotice(message);
  };
  const fail = (e: unknown) =>
    setError(e instanceof Error ? e.message : String(e));
  const projectId = route.startsWith("#/assessment/")
    ? route.split("/")[2]
    : "";
  const moduleFilter = route.startsWith("#/module/")
    ? (route.split("/")[2] as ModuleId)
    : undefined;
  const currentModule =
    moduleFilter || boot.projects.find((p) => p.id === projectId)?.module;
  useEffect(() => {
    if (loading) return;
    if (projectId && currentModule) {
      location.replace(originalEntry(currentModule, projectId, true));
    } else if (moduleFilter && labels[moduleFilter]) {
      location.replace(originalEntry(moduleFilter));
    } else if (route === "#/methods") {
      location.hash = "#/settings";
    }
  }, [loading, projectId, currentModule, moduleFilter, route]);
  const nav = (
    href: string,
    label: string,
    icon: React.ReactNode,
    active: boolean,
  ) => (
    <a
      className={active ? "active" : ""}
      href={href}
      aria-current={active ? "page" : undefined}
    >
      {icon}
      <span>{label}</span>
    </a>
  );
  return (
    <div className="application">
      <a className="skip-link" href="#main-content">
        跳到内容
      </a>
      <aside
        ref={sidebarRef}
        id="entry-sidebar"
        className={"sidebar " + (menu ? "open" : "")}
      >
        <a className="brand" href="#/projects">
          <span className="brand-mark">E</span>
          <span>
            ESG 工作台<small>本机评估与证据管理</small>
          </span>
        </a>
        <nav aria-label="主导航">
          {nav(
            "#/projects",
            "项目中心",
            <FolderOpen size={18} />,
            route === "#/projects" || route === "#/trash",
          )}
          {nav(
            "#/library",
            "资料库",
            <Files size={18} />,
            route === "#/library",
          )}
          <p className="nav-label">各标准</p>
          {(["csa", "msci"] as ModuleId[]).map((id) => (
            <div key={id}>
              {nav(
                originalEntry(id),
                labels[id],
                <BookOpen size={17} />,
                false,
              )}
            </div>
          ))}
          <p className="nav-label">各交易所</p>
          {(["mainland", "hkex"] as ModuleId[]).map((id) => (
            <div key={id}>
              {nav(
                originalEntry(id),
                labels[id],
                <BookOpen size={17} />,
                false,
              )}
            </div>
          ))}
          <p className="nav-label">对标分析</p>
          {nav(
            originalEntry("benchmark"),
            "横向对标",
            <BookOpen size={17} />,
            false,
          )}
        </nav>
        <nav className="bottom-nav" aria-label="维护与设置">
          {nav(
            "#/settings",
            "设置",
            <Settings size={18} />,
            route === "#/settings",
          )}
        </nav>
      </aside>
      {menu ? (
        <button
          className="nav-overlay"
          aria-label="关闭导航"
          onClick={() => setMenu(false)}
        />
      ) : null}
      <div ref={mainShellRef} className="main-shell">
        <header className="appbar">
          <Button
            className="menu-toggle"
            variant="ghost"
            aria-label="展开导航"
            aria-controls="entry-sidebar"
            aria-expanded={menu}
            onClick={() => setMenu(!menu)}
          >
            <Menu size={20} />
          </Button>
          <span>
            {currentModule ? labels[currentModule] : "统一 ESG 工作台"}
          </span>
          <a className="connection" href="#/settings">
            <span
              className={
                "connection-dot " + (boot.providers.length ? "connected" : "")
              }
            />
            {boot.providers.length ? boot.providers[0].model : "连接模型"}
          </a>
        </header>
        <main id="main-content">
          {error ? (
            <div role="alert" className="error">
              {error}
              <Button variant="ghost" onClick={() => setError("")}>
                关闭提示
              </Button>
            </div>
          ) : null}
          {notice ? <Notice>{notice}</Notice> : null}
          {loading ? (
            <div className="loading" role="status">
              正在读取本机资料库…
            </div>
          ) : projectId ? (
            currentModule ? (
              <p role="status">正在打开报告评估工作台…</p>
            ) : (
              <Empty title="未找到这个项目">
                <p>
                  请返回项目中心，选择已保存的项目；已删除项目可从回收站恢复。
                </p>
                <a href="#/projects">返回项目中心</a> ·{" "}
                <a href="#/trash">查看回收站</a>
              </Empty>
            )
          ) : route === "#/library" ? (
            <Library
              boot={boot}
              refresh={refresh}
              report={report}
              fail={fail}
            />
          ) : route === "#/settings" ? (
            <SettingsPage
              boot={boot}
              refresh={refresh}
              report={report}
              fail={fail}
            />
          ) : (
            <Projects
              boot={boot}
              trash={route === "#/trash"}
              onDirtyChange={markDirty}
              refresh={refresh}
              report={report}
              fail={fail}
            />
          )}
        </main>
        <footer className="app-footer">
          资料保存在本机。AI
          初评需人工复核；模型任务会发送所选材料至已连接的服务。
        </footer>
      </div>
    </div>
  );
}

type Common = {
  boot: Bootstrap;
  refresh: () => Promise<void>;
  report: (s: string) => void;
  fail: (e: unknown) => void;
};
function Library({ boot, refresh, report, fail }: Common) {
  const [busy, setBusy] = useState(false),
    [selected, setSelected] = useState<DocumentInfo>(),
    [meta, setMeta] = useState<Record<string, any>>({}),
    [preview, setPreview] = useState("");
  const add = async (files: FileList | null) => {
    if (!files) return;
    setBusy(true);
    try {
      for (const f of Array.from(files)) await upload(f);
      await refresh();
      report("PDF 已加入资料库，请补充类型、期间及来源。");
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  const columns: ColumnDef<DocumentInfo, any>[] = [
    {
      header: "报告文件",
      accessorKey: "name",
      cell: ({ row }) => (
        <button
          className="text-button"
          onClick={() => {
            setSelected(row.original);
            setMeta(row.original.meta);
          }}
        >
          {row.original.name}
          <small>
            {row.original.pageCount} 页 ·{" "}
            {(row.original.bytes / 1024 / 1024).toFixed(1)} MB
          </small>
        </button>
      ),
    },
    {
      header: "企业",
      cell: ({ row }) => row.original.meta.company || "待填写",
    },
    {
      header: "覆盖期间",
      cell: ({ row }) => row.original.meta.period || "待确认",
    },
    {
      header: "资料类型",
      cell: ({ row }) =>
        ({
          esg: "ESG／可持续发展报告",
          annual: "公司年报",
          policy: "政策／其他佐证",
        })[row.original.meta.documentType as string] || "待确认",
    },
    {
      header: "操作",
      cell: ({ row }) => (
        <Button variant="ghost" onClick={() => setPreview(row.original.id)}>
          查看原 PDF
        </Button>
      ),
    },
  ];
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>资料库</h1>
          <p>
            集中保存报告原件与来源信息。评估时在各工作台按原有方式上传资料。
          </p>
        </div>
        <label className="button button-primary file-button">
          <Upload size={17} />
          {busy ? "正在登记 PDF…" : "添加 PDF"}
          <input
            type="file"
            multiple
            accept="application/pdf,.pdf"
            aria-label="添加 PDF"
            disabled={busy}
            onChange={(e) => void add(e.target.files)}
          />
        </label>
      </div>
      {boot.documents.length ? (
        <DataTable data={boot.documents} columns={columns} />
      ) : (
        <Empty title="尚未添加报告">
          <p>
            添加 ESG 报告、公司年报或佐证材料，再核对每份文件实际覆盖的期间。
          </p>
        </Empty>
      )}
      {selected ? (
        <section className="section">
          <div className="page-heading">
            <h2>{selected.name}</h2>
            <Button variant="ghost" onClick={() => setSelected(undefined)}>
              收起资料信息
            </Button>
          </div>
          <div className="form-grid">
            <Field label="所属企业">
              <input
                value={meta.company || ""}
                onChange={(e) => setMeta({ ...meta, company: e.target.value })}
              />
            </Field>
            <Field label="资料覆盖期间／信息时点">
              <input
                value={meta.period || ""}
                onChange={(e) => setMeta({ ...meta, period: e.target.value })}
                placeholder="按报告原文填写，不使用发布日期代替"
              />
            </Field>
            <Field label="资料类型">
              <select
                value={meta.documentType || ""}
                onChange={(e) =>
                  setMeta({ ...meta, documentType: e.target.value })
                }
              >
                <option value="">待确认</option>
                <option value="esg">ESG／可持续发展报告</option>
                <option value="annual">公司年报</option>
                <option value="policy">政策／其他佐证</option>
              </select>
            </Field>
            <Field label="公开原网址／来源">
              <input
                type="url"
                value={meta.sourceUrl || ""}
                onChange={(e) =>
                  setMeta({ ...meta, sourceUrl: e.target.value })
                }
              />
            </Field>
          </div>
          <label className="check">
            <input
              type="checkbox"
              checked={meta.public === true}
              onChange={(e) => setMeta({ ...meta, public: e.target.checked })}
            />
            这是公开且可追溯的材料
          </label>
          <p className="muted">原件指纹：{selected.sha256}</p>
          <Button
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await api("/documents/" + selected.id + "/meta", meta);
                await refresh();
                report("资料信息已保存。已有评估的输入变化会提示重新核对。");
              } catch (e) {
                fail(e);
              } finally {
                setBusy(false);
              }
            }}
          >
            保存资料信息
          </Button>
        </section>
      ) : null}
      {preview ? (
        <Suspense fallback={<p>正在打开 PDF…</p>}>
          <PdfPane id={preview} onClose={() => setPreview("")} />
        </Suspense>
      ) : null}
    </>
  );
}
