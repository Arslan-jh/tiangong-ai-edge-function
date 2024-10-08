/// <reference types="https://esm.sh/v135/@supabase/functions-js/src/edge-runtime.d.ts" />

import {
  AIMessage,
  BaseMessage,
  HumanMessage,
} from "npm:/@langchain/core/messages";
import { Annotation, MemorySaver, StateGraph } from "npm:/@langchain/langgraph";

import { ChatOpenAI } from "npm:/@langchain/openai";
import { Context } from "jsr:@hono/hono";
import { DuckDuckGoSearch } from "npm:/@langchain/community/tools/duckduckgo_search";
import { RunnableToolLike } from "npm:/@langchain/core/runnables";
import SearchEsgTool from "../services/search_esg_tool.ts";
import { StructuredToolInterface } from "npm:/@langchain/core/tools";
import { ToolNode } from "npm:/@langchain/langgraph/prebuilt";
import { createClient } from "jsr:@supabase/supabase-js@2";
import supabaseAuth from "../../_shared/supabase_auth.ts";

const supabase_url = Deno.env.get("LOCAL_SUPABASE_URL") ??
  Deno.env.get("SUPABASE_URL") ?? "";
const supabase_anon_key = Deno.env.get("LOCAL_SUPABASE_ANON_KEY") ??
  Deno.env.get("SUPABASE_ANON_KEY") ?? "";

async function ragProcess(c: Context) {
  const req = c.req;
  const email = req.header("email") ?? "";
  const password = req.header("password") ?? "";

  const supabase = createClient(supabase_url, supabase_anon_key);
  const authResponse = await supabaseAuth(supabase, email, password);
  if (authResponse.status !== 200) {
    return authResponse;
  }

  const { query } = await req.json();

  const openai_api_key = Deno.env.get("OPENAI_API_KEY") ?? "";
  const openai_chat_model = Deno.env.get("OPENAI_CHAT_MODEL") ?? "";

  const StateAnnotation = Annotation.Root({
    messages: Annotation<BaseMessage[]>({
      reducer: (x, y) => x.concat(y),
    }),
  });

  const tools: (StructuredToolInterface | RunnableToolLike)[] = [
    new SearchEsgTool(),
    new DuckDuckGoSearch({ maxResults: 3 }),
  ];

  const model = new ChatOpenAI({
    apiKey: openai_api_key,
    modelName: openai_chat_model,
    temperature: 0,
    streaming: true,
  }).bindTools(tools);

  const toolNode = new ToolNode(tools);

  // Define the function that determines whether to continue or not
  // We can extract the state typing via `StateAnnotation.State`
  function shouldContinue(state: typeof StateAnnotation.State) {
    const messages = state.messages;
    const lastMessage = messages[messages.length - 1] as AIMessage;

    // If the LLM makes a tool call, then we route to the "tools" node
    if (lastMessage.tool_calls?.length) {
      return "tools";
    }
    // Otherwise, we stop (reply to the user)
    return "__end__";
  }

  // Define the function that calls the model
  async function callModel(state: typeof StateAnnotation.State) {
    const messages = state.messages;
    const response = await model.invoke(messages);

    // We return a list, because this will get added to the existing list
    return { messages: [response] };
  }

  // Define a new graph
  const workflow = new StateGraph(StateAnnotation)
    .addNode("agent", callModel)
    .addNode("tools", toolNode)
    .addEdge("__start__", "agent")
    .addConditionalEdges("agent", shouldContinue)
    .addEdge("tools", "agent");

  // Initialize memory to persist state between graph runs
  const checkpointer = new MemorySaver();

  // Finally, we compile it!
  // This compiles it into a LangChain Runnable.
  // Note that we're (optionally) passing the memory when compiling the graph
  const app = workflow.compile({ checkpointer });

  // Use the Runnable
  const finalState = await app.invoke(
    { messages: [new HumanMessage(query)] },
    { configurable: { thread_id: "42" } },
  );

  console.log(finalState.messages[finalState.messages.length - 1].content);

  return new Response(
    JSON.stringify(finalState, null, 2),
    { headers: { "Content-Type": "application/json" } },
  );
}

export default ragProcess;
