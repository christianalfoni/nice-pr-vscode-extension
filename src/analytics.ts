import * as vscode from "vscode";
import * as amplitude from "@amplitude/analytics-node";
import * as uuid from "uuid";

let user_id: string;

const ANALYTICS_API_KEY = "ce14fdb12239873be3c0a9c4245bd7d1";

export function init(context: vscode.ExtensionContext) {
  amplitude.init(ANALYTICS_API_KEY);

  user_id = context.globalState.get("user_id") || uuid.v4();

  context.globalState.update("user_id", user_id);
}

export type AnalyticsEvent =
  | {
      name: "edited_commits";
      props: {
        isInitialEdit: boolean;
      };
    }
  | {
      name: "suggested_commits";
      props:
        | {
            result: "success";
            duration: number;
          }
        | {
            result: "failure";
            error: string;
          };
    }
  | {
      name: "moved_change";
      props: {
        hasInvalidChange: boolean;
      };
    }
  | {
      name: "moved_commit";
      props: {
        hasInvalidChange: boolean;
      };
    }
  | {
      name: "moved_file";
      props: {
        hasInvalidChange: boolean;
      };
    }
  | {
      name: "edit_commits_cancelled";
    }
  | {
      name: "edit_commits_approved";
      props: {
        changesCount: number;
        trashedCount: number;
      };
    }
  | {
      name: "changed_commit_message";
    }
  | {
      name: "pushed_to_remote";
      props:
        | {
            result: "success";
            duration: number;
          }
        | {
            result: "failure";
            error: string;
          };
    }
  | {
      name: "commit_added";
    }
  | {
      name: "commit_removed";
    };

export function trackEvent(event: AnalyticsEvent) {
  amplitude.track(event.name, "props" in event ? event.props : undefined, {
    user_id,
  });
}
