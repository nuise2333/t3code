import { BotChannelId, EnvironmentId } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";

import { BotChannelPage } from "../components/bots/BotChannelPage";

function BotChannelRoute() {
  const { environmentId, channelId } = Route.useParams();
  return (
    <BotChannelPage
      key={`${environmentId}:${channelId}`}
      environmentId={EnvironmentId.make(environmentId)}
      channelId={BotChannelId.make(channelId)}
    />
  );
}

export const Route = createFileRoute("/_chat/bots_/channels/$environmentId/$channelId")({
  component: BotChannelRoute,
});
