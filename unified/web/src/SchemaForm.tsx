import Form from "@rjsf/core";
import validator from "@rjsf/validator-ajv8";
import type { RJSFSchema } from "@rjsf/utils";
export function SchemaForm({
  schema,
  value,
  onChange,
}: {
  schema: RJSFSchema;
  value: Record<string, any>;
  onChange: (v: Record<string, any>) => void;
}) {
  const ui = (s: RJSFSchema): Record<string, any> =>
    Object.fromEntries(
      Object.entries(s.properties || {}).map(([key, p]) => [
        key,
        typeof p === "object" && p.type === "object"
          ? ui(p)
          : /layout|guidance|definition|scoring_rule|sourceText|methodology|sourceNote|assessmentScope|question/i.test(
                key,
              )
            ? { "ui:widget": "textarea" }
            : {},
      ]),
    );
  return (
    <Form
      schema={schema}
      formData={value}
      validator={validator}
      onChange={(e) => onChange(e.formData || {})}
      uiSchema={{ ...ui(schema), "ui:submitButtonOptions": { norender: true } }}
    >
      <span />
    </Form>
  );
}
