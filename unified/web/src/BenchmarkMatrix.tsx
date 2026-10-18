import type { Project, Result, Method } from "./types";
import { peerChecks } from "./peer";
import { Button } from "./ui";
export function peerMatrix(
  project: Project,
  results: Result[],
  method?: Method,
) {
  return peerChecks(method, results).map(
    ({ key, title }: { key: string; title: string }) => {
      const cells = project.documents.map((d) =>
        results.find((r) => r.id === d.id + "::" + key),
      );
      const peers = cells.filter(
        (r, i) =>
          !project.documents[i].isOwn && r && ["Yes", "N"].includes(r.status),
      );
      const yes = peers.filter((r) => r?.status === "Yes").length;
      return {
        key,
        title,
        cells,
        yes,
        checked: peers.length,
        total: project.documents.filter((d) => !d.isOwn).length,
        rate: peers.length ? yes / peers.length : undefined,
      };
    },
  );
}
export function BenchmarkMatrix({
  project,
  results,
  method,
  onSelect,
}: {
  project: Project;
  results: Result[];
  method?: Method;
  onSelect: (id: string) => void;
}) {
  return (
    <>
      <h3>同业披露矩阵</h3>
      <p className="muted">
        点击结论查看证据与复核评论。覆盖率只计算已核对同业，本公司不计入；未完成保持空白。
      </p>
      <div
        className="table-scroll benchmark-matrix"
        tabIndex={0}
        role="region"
        aria-label="横向对标结果表"
      >
        <table>
          <thead>
            <tr>
              <th>检查项</th>
              {project.documents.map((d) => (
                <th key={d.id}>
                  {d.company || d.id}
                  {d.isOwn ? "（本公司）" : ""}
                  <small>{d.period}</small>
                </th>
              ))}
              <th>同业覆盖率</th>
            </tr>
          </thead>
          <tbody>
            {peerMatrix(project, results, method).map((row) => (
              <tr key={row.key}>
                <th scope="row">{row.title}</th>
                {row.cells.map((r, i) => (
                  <td key={project.documents[i].id}>
                    {r ? (
                      <Button variant="ghost" onClick={() => onSelect(r.id)}>
                        {["Yes", "N"].includes(r.status) ? r.status : "待核对"}
                      </Button>
                    ) : (
                      ""
                    )}
                  </td>
                ))}
                <td>
                  {row.rate === undefined
                    ? "—"
                    : Math.round(row.rate * 100) + "%"}
                  <small>
                    {row.yes} / {row.checked} 已核对 · 同业共 {row.total}
                  </small>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
