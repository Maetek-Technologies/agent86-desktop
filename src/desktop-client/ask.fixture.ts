// Test fixture: the form agent86-core 1.2.2 builds for an `ask_user` call (`ask::form_messages`),
// captured from the thread tests' scripted call (`trip_questions` in src-tauri/src/threads/tests.rs).
// The model sent only the title and three questions; agent86 wrote the rest.
import type { UiMessage } from "./session-state.ts";

export const TRIP_FORM: UiMessage = {
  version: "1.0",
  createSurface: {
    surfaceId: "agent86_ask_1",
    catalogId: "https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json",
    components: [
      {
        id: "root",
        component: "Column",
        children: ["title", "q_from", "q_style", "o_style", "q_nights", "send"],
      },
      { id: "title", component: "Text", text: "Your weekend trip" },
      {
        id: "q_from",
        component: "TextField",
        label: "Where are you leaving from?",
        variant: "shortText",
        value: { "@path": "/answers/from" },
      },
      {
        id: "q_style",
        component: "ChoicePicker",
        label: "What kind of trip?",
        variant: "mutuallyExclusive",
        options: [
          { label: "City and culture", value: "City and culture" },
          { label: "Outdoors", value: "Outdoors" },
          { label: "Other", value: "__other__" },
        ],
        value: { "@path": "/answers/style" },
      },
      {
        id: "o_style",
        component: "TextField",
        label: "Other, in your own words",
        variant: "shortText",
        value: { "@path": "/other/style" },
      },
      {
        id: "q_nights",
        component: "TextField",
        label: "How many nights? (optional)",
        variant: "number",
        value: { "@path": "/answers/nights" },
      },
      {
        id: "send",
        component: "Button",
        "@checks": [
          {
            condition: {
              "@call": "and",
              args: {
                values: [
                  { "@call": "required", args: { value: { "@path": "/answers/from" } } },
                  { "@call": "required", args: { value: { "@path": "/answers/style" } } },
                ],
              },
            },
            message: "Answer every question not marked (optional) to send.",
          },
        ],
        child: "send_label",
        variant: "primary",
        action: {
          event: {
            name: "answers",
            context: { answers: { "@path": "/answers" }, other: { "@path": "/other" } },
          },
        },
      },
      { id: "send_label", component: "Text", text: "Send answers" },
    ],
    dataModel: { answers: { from: "", style: [], nights: "" }, other: { style: "" } },
  },
};
