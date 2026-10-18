import { useEffect, useRef, useState } from "react";
import {
  Plus,
  Trash2,
  Pencil,
  Undo2,
  RefreshCw,
  ArrowRight,
} from "lucide-react";
import { api } from "./api";
import { Button, Empty, Field, Notice } from "./ui";
import { moduleLabels as labels, originalEntry } from "./entries";
import type { Common, ModuleId, Project } from "./types";

const defaults: Record<ModuleId, Record<string, unknown>> = {
  csa: { industry: "CON", listed: "unknown", industryBasis: "" },
  msci: { acknowledged: false },
  mainland: { exchange: "sh", board: "" },
  hkex: {},
  benchmark: {},
};
const date = (value?: number) =>
  value ? new Date(value * 1000).toLocaleString("zh-CN") : "—";
type Props = Common & {
  trash: boolean;
  onDirtyChange: (value: boolean) => void;
};

function DeleteDialog({
  project,
  busy,
  onCancel,
  onConfirm,
}: {
  project: Project;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const node = dialog.current!;
    node.showModal();
    return () => node.close();
  }, []);
  return (
    <dialog
      className="project-dialog"
      ref={dialog}
      aria-labelledby="delete-project-title"
      aria-describedby="delete-project-description"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onCancel();
      }}
    >
      <h2 id="delete-project-title">删除项目？</h2>
      <p className="project-confirm-name">{project.name}</p>
      <p id="delete-project-description">
        项目将移入回收站。原报告、评估结果和评论保留，可随时恢复。
      </p>
      <div className="actions">
        <Button variant="outline" autoFocus disabled={busy} onClick={onCancel}>
          取消
        </Button>
        <Button variant="danger" disabled={busy} onClick={onConfirm}>
          {busy ? "正在删除…" : "移入回收站"}
        </Button>
      </div>
    </dialog>
  );
}

export default function Projects({
  boot,
  refresh,
  report,
  fail,
  trash,
  onDirtyChange,
}: Props) {
  const initial = new URLSearchParams(location.search).get("new") as ModuleId;
  const [creating, setCreating] = useState(Boolean(labels[initial])),
    [name, setName] = useState(""),
    [company, setCompany] = useState(""),
    [chosen, setChosen] = useState<ModuleId>(labels[initial] ? initial : "csa"),
    [period, setPeriod] = useState(""),
    [target, setTarget] = useState(""),
    [query, setQuery] = useState(""),
    [filter, setFilter] = useState("all"),
    [busy, setBusy] = useState(""),
    [page, setPage] = useState(0),
    [renaming, setRenaming] = useState<Project>(),
    [newName, setNewName] = useState(""),
    [deleting, setDeleting] = useState<Project>(),
    [undo, setUndo] = useState<Project>();
  const mutation = useRef(false);
  useEffect(() => {
    onDirtyChange(
      Boolean(
        (creating && (name || company || period || target)) ||
          (renaming && newName !== renaming.name),
      ),
    );
    return () => onDirtyChange(false);
  }, [
    creating,
    name,
    company,
    period,
    target,
    renaming,
    newName,
    onDirtyChange,
  ]);
  useEffect(() => {
    setPage(0);
    setRenaming(undefined);
    setDeleting(undefined);
    setCreating(false);
  }, [trash]);
  useEffect(() => {
    if (labels[initial] && !trash) setCreating(true);
  }, []);
  const perform = async (id: string, action: () => Promise<void>) => {
    if (mutation.current) return;
    mutation.current = true;
    setBusy(id);
    try {
      await action();
    } catch (error) {
      fail(error);
    } finally {
      mutation.current = false;
      setBusy("");
    }
  };
  const resetForm = () => {
    setCreating(false);
    setName("");
    setCompany("");
    setPeriod("");
    setTarget("");
    onDirtyChange(false);
  };
  const create = async () => {
    const project = await api<Project>("/projects", {
      name: name.trim(),
      company: company.trim(),
      module: chosen,
      reportPeriod: period.trim(),
      targetPeriod: target.trim(),
      options: defaults[chosen],
      documents: [],
      selected: [],
      comments: {},
    });
    onDirtyChange(false);
    location.assign(originalEntry(chosen, project.id, true));
  };
  const restore = async (project: Project) =>
    perform(project.id, async () => {
      await api("/projects/" + project.id + "/restore", {
        revision: project.revision,
      });
      if (undo?.id === project.id) setUndo(undefined);
      await refresh();
      report("项目已恢复，可从项目列表打开。");
    });
  const archive = async () => {
    if (!deleting) return;
    const project = deleting;
    await perform(project.id, async () => {
      const result = await api<{ project: Project }>(
        "/projects/" + project.id + "/archive",
        { revision: project.revision },
      );
      setUndo(result.project);
      if (renaming?.id === project.id) {
        setRenaming(undefined);
        onDirtyChange(false);
      }
      await refresh();
    });
    setDeleting(undefined);
  };
  const source = trash ? boot.trashProjects || [] : boot.projects;
  const projects = source.filter(
    (project) =>
      (filter === "all" || project.module === filter) &&
      [project.name, project.company]
        .join(" ")
        .toLocaleLowerCase()
        .includes(query.trim().toLocaleLowerCase()),
  );
  const pages = Math.max(1, Math.ceil(projects.length / 20)),
    current = Math.min(page, pages - 1);
  const rows = projects.slice(current * 20, (current + 1) * 20);
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>{trash ? "回收站" : "项目中心"}</h1>
          <p>
            {trash
              ? "删除的项目保留在这里，恢复后可继续使用。"
              : "创建、打开和管理各标准或交易所的评估项目。"}
          </p>
        </div>
        <div className="actions">
          <Button
            variant="ghost"
            disabled={Boolean(busy)}
            onClick={() => void perform("refresh", refresh)}
            aria-label="刷新项目列表"
          >
            <RefreshCw size={16} />
            刷新
          </Button>
          {trash ? (
            <Button variant="outline" asChild>
              <a href="#/projects">返回项目列表</a>
            </Button>
          ) : (
            <>
              <Button variant="outline" asChild>
                <a href="#/trash">
                  <Trash2 size={16} />
                  回收站
                  {boot.trashProjects?.length
                    ? `（${boot.trashProjects.length}）`
                    : ""}
                </a>
              </Button>
              <Button
                disabled={Boolean(busy)}
                onClick={() => {
                  setCreating(!creating);
                  setRenaming(undefined);
                }}
              >
                <Plus size={17} />
                新建项目
              </Button>
            </>
          )}
        </div>
      </div>
      {undo && !trash ? (
        <Notice>
          “{undo.name}”已移入回收站。{" "}
          <Button
            variant="ghost"
            disabled={Boolean(busy)}
            onClick={() => void restore(undo)}
          >
            <Undo2 size={15} />
            撤销删除
          </Button>
        </Notice>
      ) : null}
      {creating && !trash ? (
        <form
          className="section"
          onSubmit={(event) => {
            event.preventDefault();
            void perform("create", create);
          }}
        >
          <h2>新建项目</h2>
          <fieldset disabled={Boolean(busy)}>
            <div className="form-grid">
              <Field label="项目名称">
                <input
                  autoFocus
                  required
                  maxLength={160}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="输入项目名称"
                />
              </Field>
              <Field label="评估模块">
                <select
                  value={chosen}
                  onChange={(e) => setChosen(e.target.value as ModuleId)}
                >
                  {Object.entries(labels).map(([key, label]) => (
                    <option key={key} value={key}>
                      {label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field
                label={chosen === "benchmark" ? "企业名称（可选）" : "企业名称"}
              >
                <input
                  required={chosen !== "benchmark"}
                  maxLength={160}
                  value={company}
                  onChange={(e) => setCompany(e.target.value)}
                />
              </Field>
              <Field label="报告覆盖期间（可稍后填写）">
                <input
                  maxLength={80}
                  value={period}
                  onChange={(e) => setPeriod(e.target.value)}
                  placeholder={
                    chosen === "csa"
                      ? "例如 2025-01-01 至 2025-12-31"
                      : "例如 2025"
                  }
                />
              </Field>
              <Field label="目标披露期间（可稍后填写）">
                <input
                  maxLength={80}
                  value={target}
                  onChange={(e) => setTarget(e.target.value)}
                  placeholder="例如 2026"
                />
              </Field>
            </div>
            <div className="actions">
              <Button
                type="submit"
                disabled={
                  !name.trim() || (chosen !== "benchmark" && !company.trim())
                }
              >
                {busy === "create" ? "正在创建…" : "创建并打开"}
              </Button>
              <Button type="button" variant="ghost" onClick={resetForm}>
                取消
              </Button>
            </div>
          </fieldset>
        </form>
      ) : null}
      {renaming && !trash ? (
        <form
          className="section"
          onSubmit={(event) => {
            event.preventDefault();
            void perform(renaming.id, async () => {
              await api("/projects/" + renaming.id + "/rename", {
                name: newName,
                revision: renaming.revision,
              });
              setRenaming(undefined);
              onDirtyChange(false);
              await refresh();
              report("项目名称已更新。");
            });
          }}
        >
          <h2>修改项目名称</h2>
          <Field label="项目名称">
            <input
              autoFocus
              maxLength={160}
              required
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              disabled={Boolean(busy)}
            />
          </Field>
          <div className="actions">
            <Button disabled={Boolean(busy) || !newName.trim()}>
              保存名称
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={Boolean(busy)}
              onClick={() => setRenaming(undefined)}
            >
              取消
            </Button>
          </div>
        </form>
      ) : null}
      <div className="project-filters">
        <input
          aria-label="搜索项目"
          placeholder="搜索项目或企业"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setPage(0);
          }}
        />
        <select
          aria-label="筛选评估模块"
          value={filter}
          onChange={(event) => {
            setFilter(event.target.value);
            setPage(0);
          }}
        >
          <option value="all">全部模块</option>
          {Object.entries(labels).map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>
        <span className="muted">共 {projects.length} 个项目</span>
      </div>
      {projects.length ? (
        <div className="table-scroll">
          <table
            className="project-table"
            aria-label={trash ? "已删除项目" : "项目列表"}
          >
            <thead>
              <tr>
                <th>项目</th>
                <th>模块</th>
                <th>报告覆盖期间</th>
                <th>{trash ? "删除时间" : "最近更新"}</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((project) => (
                <tr key={project.id}>
                  <td>
                    {trash ? (
                      <strong>{project.name}</strong>
                    ) : (
                      <a
                        className="project-link"
                        href={originalEntry(project.module, project.id, true)}
                      >
                        {project.name}
                      </a>
                    )}
                    {project.company && project.company !== project.name ? (
                      <small>{project.company}</small>
                    ) : null}
                    {!trash ? (
                      <small>
                        {project.hasNativeDraft ? "已保存草稿" : "待填写与上传"}
                      </small>
                    ) : null}
                  </td>
                  <td>{labels[project.module]}</td>
                  <td>{project.reportPeriod || "待填写"}</td>
                  <td>{date(trash ? project.deletedAt : project.updatedAt)}</td>
                  <td>
                    <div className="project-actions">
                      {trash ? (
                        <Button
                          variant="outline"
                          disabled={Boolean(busy)}
                          onClick={() => void restore(project)}
                        >
                          <Undo2 size={15} />
                          {busy === project.id ? "正在恢复…" : "恢复项目"}
                        </Button>
                      ) : (
                        <>
                          <a
                            href={originalEntry(
                              project.module,
                              project.id,
                              true,
                            )}
                          >
                            打开
                            <ArrowRight size={14} />
                          </a>
                          <Button
                            variant="ghost"
                            disabled={Boolean(busy)}
                            aria-label={"改名：" + project.name}
                            onClick={() => {
                              setRenaming(project);
                              setNewName(project.name);
                              resetForm();
                            }}
                          >
                            <Pencil size={14} />
                            改名
                          </Button>
                          <Button
                            variant="ghost"
                            className="project-delete"
                            disabled={Boolean(busy)}
                            aria-label={"删除：" + project.name}
                            onClick={() => setDeleting(project)}
                          >
                            <Trash2 size={14} />
                            删除
                          </Button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty
          title={
            query || filter !== "all"
              ? "未找到匹配的项目"
              : trash
                ? "回收站为空"
                : "尚未创建项目"
          }
        >
          <p>
            {query || filter !== "all"
              ? "调整关键词或模块筛选后重试。"
              : trash
                ? "删除的项目会出现在这里，可恢复原报告和记录。"
                : "新建项目，或进入工作台填写并保存，项目会显示在这里。"}
          </p>
          {query || filter !== "all" ? (
            <Button
              variant="outline"
              onClick={() => {
                setQuery("");
                setFilter("all");
              }}
            >
              清除筛选
            </Button>
          ) : !trash ? (
            <Button variant="outline" onClick={() => setCreating(true)}>
              新建项目
            </Button>
          ) : null}
        </Empty>
      )}
      {pages > 1 ? (
        <nav className="project-pagination" aria-label="项目分页">
          <Button
            variant="outline"
            disabled={current === 0}
            onClick={() => setPage(current - 1)}
          >
            上一页
          </Button>
          <span>
            第 {current + 1} / {pages} 页
          </span>
          <Button
            variant="outline"
            disabled={current >= pages - 1}
            onClick={() => setPage(current + 1)}
          >
            下一页
          </Button>
        </nav>
      ) : null}
      {deleting ? (
        <DeleteDialog
          project={deleting}
          busy={busy === deleting.id}
          onCancel={() => setDeleting(undefined)}
          onConfirm={() => void archive()}
        />
      ) : null}
    </>
  );
}
