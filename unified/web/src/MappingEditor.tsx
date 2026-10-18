import type { Project, Run, Criterion } from "./types";
import { Button } from "./ui";
export function MappingEditor({
  project,
  run,
  criteria,
  active,
  onChange,
}: {
  project: Project;
  run: Run;
  criteria: Criterion[];
  active: boolean;
  onChange: (v: Record<string, any[]>) => void;
}) {
  return (
    <details className="mapping-editor">
      <summary>核对与修正章节映射</summary>
      <p>
        修正后保存并重新初评，旧结果保留为历史。报告原件或方法改变后，请先重新初评以取得对应候选章节。
      </p>
      {Object.entries(run.alignments || {}).map(([id, alignment]) => {
        const rows = project.mappingOverrides?.[id] || alignment.mappings;
        const change = (value: any[]) =>
          onChange({ ...project.mappingOverrides, [id]: value });
        return (
          <fieldset key={id} disabled={active}>
            <legend>
              {project.documents.find((d) => d.id === id)?.company || "主报告"}{" "}
              · {alignment.candidates.length} 个候选
            </legend>
            {rows.map((m, i) => (
              <div className="mapping-row" key={i}>
                <select
                  aria-label={"映射" + (i + 1) + "章节"}
                  value={m.candidateId}
                  onChange={(e) =>
                    change(
                      rows.map((v, n) =>
                        n === i ? { ...v, candidateId: e.target.value } : v,
                      ),
                    )
                  }
                >
                  {alignment.candidates.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.reportSection} · PDF {c.sourcePage?.join("、")}
                    </option>
                  ))}
                </select>
                <select
                  aria-label={"映射" + (i + 1) + "指标"}
                  value={m.topicId}
                  onChange={(e) =>
                    change(
                      rows.map((v, n) =>
                        n === i ? { ...v, topicId: e.target.value } : v,
                      ),
                    )
                  }
                >
                  {criteria.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.title}
                    </option>
                  ))}
                </select>
                <Button
                  variant="ghost"
                  onClick={() => change(rows.filter((_, n) => n !== i))}
                >
                  移除映射
                </Button>
              </div>
            ))}
            <Button
              variant="outline"
              disabled={!alignment.candidates.length}
              onClick={() =>
                change([
                  ...rows,
                  {
                    candidateId: alignment.candidates[0].id,
                    topicId: criteria[0].id,
                    confidence: 0.5,
                  },
                ])
              }
            >
              添加映射
            </Button>
          </fieldset>
        );
      })}
    </details>
  );
}
