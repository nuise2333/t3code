import { useAtomValue } from "@effect/atom-react";
import { ROUTING_TASK_CLASS_LABELS } from "@t3tools/client-runtime/routing";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, RoutingSummaryRow, RoutingTaskClass } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { AsyncResult, Atom } from "effect/reactivity";

import { environmentPresentations } from "../../state/presentation";
import { serverEnvironment } from "../../state/server";

const routingSummaryAtom = Atom.family((key: string) => {
  const [environmentIds, days] = JSON.parse(key) as [ReadonlyArray<EnvironmentId>, number];
  return Atom.make((get) =>
    Effect.forEach(
      environmentIds,
      (environmentId) =>
        Effect.promise(() =>
          runAtomCommand(
            get.registry,
            serverEnvironment.routingSummary,
            { environmentId, input: { days } },
            { reportFailure: false },
          ),
        ).pipe(Effect.map((result) => (result._tag === "Success" ? result.value.rows : []))),
      { concurrency: "unbounded" },
    ).pipe(Effect.map(sumRows)),
  ).pipe(Atom.setIdleTTL(60_000), Atom.withLabel(`routing-summary:${key}`));
});

function sumRows(
  perEnvironment: ReadonlyArray<ReadonlyArray<RoutingSummaryRow>>,
): ReadonlyArray<RoutingSummaryRow> {
  const totals = new Map<RoutingTaskClass, RoutingSummaryRow>();
  for (const row of perEnvironment.flat()) {
    const seen = totals.get(row.taskClass);
    totals.set(
      row.taskClass,
      seen === undefined
        ? row
        : {
            taskClass: row.taskClass,
            threads: seen.threads + row.threads,
            effortChanged: seen.effortChanged + row.effortChanged,
            effortShadow: seen.effortShadow + row.effortShadow,
            modelSwitched: seen.modelSwitched + row.modelSwitched,
            modelShadow: seen.modelShadow + row.modelShadow,
            groupLaunches: seen.groupLaunches + row.groupLaunches,
          },
    );
  }
  return [...totals.values()];
}

const NO_ROWS = Atom.make(AsyncResult.success<ReadonlyArray<RoutingSummaryRow>>([]));

const COLUMNS = [
  "effortChanged",
  "modelSwitched",
  "groupLaunches",
] as const satisfies ReadonlyArray<keyof RoutingSummaryRow>;

/** What Auto and routing groups decided at launch, for threads started in the window. */
export function UsageRoutingSection({
  environmentIds,
  days,
}: {
  readonly environmentIds: ReadonlyArray<EnvironmentId>;
  readonly days: number;
}) {
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const supported = environmentIds.filter(
    (id) => presentations.get(id)?.serverConfig?.environment.capabilities.routingSummary === true,
  );
  const result = useAtomValue(
    supported.length === 0
      ? NO_ROWS
      : routingSummaryAtom(JSON.stringify([[...supported].toSorted(), days])),
  );
  const rows = AsyncResult.isSuccess(result) ? result.value : [];
  if (rows.length === 0) return null;

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 className="text-sm font-medium text-foreground">Routing</h2>
        <p className="text-xs text-muted-foreground">
          What Auto and routing groups decided when threads in this window started. These are
          decisions, not savings.
        </p>
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-right text-xs text-muted-foreground">
            <th className="w-full py-2 pl-2 text-left font-normal">Kind of task</th>
            <th className="py-2 pl-6 font-normal">Threads</th>
            <th className="py-2 pl-6 font-normal">Level set</th>
            <th className="hidden py-2 pl-6 font-normal sm:table-cell">Model switched</th>
            <th className="hidden py-2 pl-6 font-normal sm:table-cell">Through a group</th>
            <th className="hidden py-2 pr-2 pl-6 font-normal md:table-cell">Would change if on</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.taskClass}
              className="border-b border-border/50 text-right whitespace-nowrap text-muted-foreground tabular-nums"
            >
              <td className="py-2.5 pl-2 text-left text-foreground">
                {ROUTING_TASK_CLASS_LABELS[row.taskClass]}
              </td>
              <td className="py-2.5 pl-6">{row.threads}</td>
              {COLUMNS.map((column) => (
                <td
                  key={column}
                  className={
                    column === "effortChanged" ? "py-2.5 pl-6" : "hidden py-2.5 pl-6 sm:table-cell"
                  }
                >
                  {row[column]}
                </td>
              ))}
              <td className="hidden py-2.5 pr-2 pl-6 md:table-cell">
                {row.effortShadow + row.modelShadow}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
