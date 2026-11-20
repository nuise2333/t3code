import { createFileRoute } from "@tanstack/react-router";

import { BotsPage } from "../components/bots/BotsPage";
import { validateBotsSearch } from "../components/bots/botsPage.logic";

function BotsRoute() {
  const { bot } = Route.useSearch();
  return <BotsPage selectedBotId={bot ?? null} />;
}

export const Route = createFileRoute("/_chat/bots")({
  validateSearch: validateBotsSearch,
  component: BotsRoute,
});
