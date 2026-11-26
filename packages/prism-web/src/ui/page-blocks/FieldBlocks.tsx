import { useId } from "react";
import { CheckCircle2, Circle } from "lucide-react";
import {
  allPageBlocks, buildButtonPayload, canSubmitButton, type PageButton, type PageConsent, type PageInputField,
  type PageSelectField, type PageToggleField,
} from "@prism/page-protocol";
import { usePageContext } from "./page-context";

export function InputBlock({ block }: { block: PageInputField }) {
  const { page, form, actions } = usePageContext();
  const fieldId = useId();
  const value = form.values[block.id];
  const submitOnEnter = () => {
    const blocks = allPageBlocks(page);
    const matching = blocks.filter(
      (candidate): candidate is PageButton => candidate.kind === "button" && !!candidate.collect?.includes(block.id),
    );
    if (matching.length !== 1) return false;
    const target = matching[0]!;
    if (target.confirm || actions.blocked || !canSubmitButton(target, blocks, form.values)) return false;
    void actions.run(target.id, target.action, buildButtonPayload(target, blocks, form.values), target.needsLocation, target.wait);
    return true;
  };
  return (
    <div className="page-field">
      {block.label && <label htmlFor={fieldId} className="page-field-label">{block.label}</label>}
      <input
        id={fieldId}
        className="page-input focus-ring"
        type="text"
        inputMode={block.inputType === "number" ? "decimal" : "text"}
        placeholder={block.placeholder ?? ""}
        maxLength={block.maxLength}
        disabled={actions.blocked || block.enabled === false}
        value={typeof value === "string" ? value : ""}
        onChange={(event) => {
          const raw = event.target.value;
          form.setValue(block.id, block.maxLength && block.maxLength > 0 ? raw.slice(0, block.maxLength) : raw);
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
          if (submitOnEnter()) event.preventDefault();
        }}
      />
      {block.helperText && <p className="page-field-help">{block.helperText}</p>}
    </div>
  );
}

export function SelectBlock({ block }: { block: PageSelectField }) {
  const { form, actions } = usePageContext();
  const labelId = useId();
  if (!block.options.length) return null;
  const current = form.values[block.id];
  const disabled = actions.blocked || block.enabled === false;
  const segmented = block.style === "segmented";
  return (
    <div className="page-field">
      {block.label && <span id={labelId} className="page-field-label">{block.label}</span>}
      <div className={segmented ? "page-select-segments" : "page-select-list"} role="radiogroup" aria-labelledby={block.label ? labelId : undefined}>
        {block.options.map((option) => {
          const selected = current === option.value;
          return (
            <button
              key={option.value}
              type="button"
              className={segmented ? undefined : "page-select-option"}
              role="radio"
              aria-checked={selected}
              data-selected={selected}
              disabled={disabled || option.disabled}
              onClick={() => form.setValue(block.id, option.value)}
            >
              {segmented ? option.label : (
                <>
                  <span className="page-select-option-copy">
                    <strong>{option.label}</strong>
                    {option.detail && <small>{option.detail}</small>}
                  </span>
                  {selected
                    ? <CheckCircle2 size={20} className="text-mint shrink-0" aria-hidden="true" />
                    : <Circle size={20} className="text-ink/25 shrink-0" aria-hidden="true" />}
                </>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function ToggleBlock({ block }: { block: PageToggleField }) {
  const { form, actions } = usePageContext();
  const disabled = actions.blocked || block.enabled === false;
  return (
    <label className={`page-toggle${disabled ? " is-disabled" : ""}`}>
      <span className="page-toggle-copy">
        <span className="page-toggle-label">{block.label}</span>
        {block.description && <span className="page-toggle-desc">{block.description}</span>}
      </span>
      <input
        type="checkbox"
        role="switch"
        className="page-switch"
        checked={form.values[block.id] === true}
        disabled={disabled}
        onChange={(event) => form.setValue(block.id, event.target.checked)}
      />
    </label>
  );
}

export function ConsentBlock({ block }: { block: PageConsent }) {
  const { form } = usePageContext();
  return (
    <label className="flex items-start gap-3 text-sm leading-relaxed">
      <input
        className="mt-1 shrink-0"
        type="checkbox"
        checked={form.values[block.id] === true}
        onChange={(event) => form.setValue(block.id, event.target.checked)}
      />
      <span>{block.text}</span>
    </label>
  );
}
