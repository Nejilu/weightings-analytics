import type { HoldingsSourceIssue } from "@/domain/holdings-source-issues";

export function HoldingsSourceWarning({ issues }: { issues?: HoldingsSourceIssue[] }) {
  if (!issues?.length) return null;
  const unique = [...new Map(issues.map((issue) => [JSON.stringify(issue), issue])).values()];
  return (
    <div className="alert alert--error" role="alert">
      <strong>Holdings refresh failed — showing previously saved data.</strong>
      <ul>
        {unique.map((issue) => (
          <li key={JSON.stringify(issue)}>
            <b>{issue.ticker}</b>: holdings as of {issue.asOf}.{" "}
            <code>{issue.code}</code> — {issue.message}
          </li>
        ))}
      </ul>
    </div>
  );
}
