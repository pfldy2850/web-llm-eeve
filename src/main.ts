import appConfig from "./app-config";
import * as webllm from "@mlc-ai/web-llm";

function getElementAndCheck(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (element == null) {
    throw Error("Cannot find element " + id);
  }
  return element;
}
const selectedModel = "EEVE-Korean-Instruct-10.8B-v1.0-q4f16_1";

class ChatUI {
  private uiChat: HTMLElement;
  private uiChatInput: HTMLInputElement;
  private uiChatInfoLabel: HTMLLabelElement;
  private engine: webllm.MLCEngineInterface | webllm.WebWorkerMLCEngine;
  private config: webllm.AppConfig = appConfig;
  private selectedModel: string = selectedModel;
  private chatLoaded = false;
  private requestInProgress = false;
  private chatHistory: webllm.ChatCompletionMessageParam[] = [];
  // We use a request chain to ensure that
  // all requests send to chat are sequentialized
  private chatRequestChain: Promise<void> = Promise.resolve();

  /**
   * An asynchronous factory constructor since we need to await getMaxStorageBufferBindingSize();
   * this is not allowed in a constructor (which cannot be asynchronous).
   */
  public static CreateAsync = async (engine: webllm.MLCEngineInterface) => {
    const chatUI = new ChatUI();

    chatUI.engine = engine;
    // get the elements
    chatUI.uiChat = getElementAndCheck("chatui-chat");
    chatUI.uiChatInput = getElementAndCheck("chatui-input") as HTMLInputElement;
    chatUI.uiChatInfoLabel = getElementAndCheck(
      "chatui-info-label"
    ) as HTMLLabelElement;
    // register event handlers
    getElementAndCheck("chatui-reset-btn").onclick = () => {
      chatUI.onReset();
    };
    getElementAndCheck("chatui-send-btn").onclick = () => {
      chatUI.onGenerate();
    };
    // TODO: find other alternative triggers
    getElementAndCheck("chatui-input").onkeypress = (event) => {
      if (event.keyCode === 13) {
        chatUI.onGenerate();
      }
    };

    // When we detect low maxStorageBufferBindingSize, we assume that the device (e.g. an Android
    // phone) can only handle small models and make all other models unselectable. Otherwise, the
    // browser may crash. See https://github.com/mlc-ai/web-llm/issues/209.
    // Also use GPU vendor to decide whether it is a mobile device (hence with limited resources).
    const androidMaxStorageBufferBindingSize = 1 << 27; // 128MB
    const mobileVendors = new Set<string>(["qualcomm", "arm"]);
    let restrictModels = false;
    let maxStorageBufferBindingSize: number;
    let gpuVendor: string;
    try {
      [maxStorageBufferBindingSize, gpuVendor] = await Promise.all([
        engine.getMaxStorageBufferBindingSize(),
        engine.getGPUVendor(),
      ]);
    } catch (err) {
      chatUI.appendMessage("error", "Init error, " + err.toString());
      console.log(err.stack);
      return;
    }
    if (
      (gpuVendor.length != 0 && mobileVendors.has(gpuVendor)) ||
      maxStorageBufferBindingSize <= androidMaxStorageBufferBindingSize
    ) {
      chatUI.appendMessage(
        "init",
        "Your device seems to have " +
          "limited resources, so we restrict the selectable models."
      );
      restrictModels = true;
    }

    await chatUI.asyncInitChat();

    return chatUI;
  };

  /**
   * Push a task to the execution queue.
   *
   * @param task The task to be executed;
   */
  private pushTask(task: () => Promise<void>) {
    const lastEvent = this.chatRequestChain;
    this.chatRequestChain = lastEvent.then(task);
  }
  // Event handlers
  // all event handler pushes the tasks to a queue
  // that get executed sequentially
  // the tasks previous tasks, which causes them to early stop
  // can be interrupted by engine.interruptGenerate
  private async onGenerate() {
    if (this.requestInProgress) {
      return;
    }
    this.pushTask(async () => {
      await this.asyncGenerate();
    });
  }

  private async onReset() {
    if (this.requestInProgress) {
      // interrupt previous generation if any
      this.engine.interruptGenerate();
    }
    // try reset after previous requests finishes
    this.pushTask(async () => {
      await this.engine.resetChat();
      this.resetChatHistory();
    });
  }

  // Internal helper functions
  private appendMessage(kind, text) {
    if (kind == "init") {
      text = "[System Initalize] " + text;
    }
    if (this.uiChat === undefined) {
      throw Error("cannot find ui chat");
    }
    const msg = `
      <div class="msg ${kind}-msg">
        <div class="msg-bubble">
          <div class="msg-text">${text}</div>
        </div>
      </div>
    `;
    this.uiChat.insertAdjacentHTML("beforeend", msg);
    this.uiChat.scrollTo(0, this.uiChat.scrollHeight);
  }

  // Special care for user input such that we treat it as pure text instead of html
  private appendUserMessage(text: string) {
    if (this.uiChat === undefined) {
      throw Error("cannot find ui chat");
    }
    const msg = `
      <div class="msg right-msg">
        <div class="msg-bubble">
          <div class="msg-text"></div>
        </div>
      </div>
    `;
    this.uiChat.insertAdjacentHTML("beforeend", msg);
    // Recurse three times to get `msg-text`
    const msgElement = this.uiChat.lastElementChild?.lastElementChild
      ?.lastElementChild as HTMLElement;
    msgElement.insertAdjacentText("beforeend", text);
    this.uiChat.scrollTo(0, this.uiChat.scrollHeight);
  }

  private updateLastMessage(kind, text) {
    if (kind == "init") {
      text = "[System Initialize] " + text;
    }
    if (this.uiChat === undefined) {
      throw Error("cannot find ui chat");
    }
    const matches = this.uiChat.getElementsByClassName(`msg ${kind}-msg`);
    if (matches.length == 0) throw Error(`${kind} message do not exist`);
    const msg = matches[matches.length - 1];
    const msgText = msg.getElementsByClassName("msg-text");
    if (msgText.length != 1) throw Error("Expect msg-text");
    if (msgText[0].innerHTML == text) return;
    const list = text.split("\n").map((t) => {
      const item = document.createElement("div");
      item.textContent = t;
      return item;
    });
    msgText[0].innerHTML = "";
    list.forEach((item) => msgText[0].append(item));
    this.uiChat.scrollTo(0, this.uiChat.scrollHeight);
  }

  private resetChatHistory() {
    this.chatHistory = [];
    const clearTags = ["left", "right", "init", "error"];
    for (const tag of clearTags) {
      // need to unpack to list so the iterator don't get affected by mutation
      const matches = [...this.uiChat.getElementsByClassName(`msg ${tag}-msg`)];
      for (const item of matches) {
        this.uiChat.removeChild(item);
      }
    }
    if (this.uiChatInfoLabel !== undefined) {
      this.uiChatInfoLabel.innerHTML = "";
    }
  }

  private async asyncInitChat() {
    if (this.chatLoaded) return;
    this.requestInProgress = true;
    this.appendMessage("init", "");
    const initProgressCallback = (report) => {
      this.updateLastMessage("init", report.text);
    };
    this.engine.setInitProgressCallback(initProgressCallback);

    try {
      await this.engine.reload(this.selectedModel);
    } catch (err) {
      this.appendMessage("error", "Init error, " + err.toString());
      console.log(err.stack);
      this.unloadChat();
      this.requestInProgress = false;
      return;
    }
    this.requestInProgress = false;
    this.chatLoaded = true;
  }

  private async unloadChat() {
    await this.engine.unload();
    this.chatLoaded = false;
  }

  /**
   * Run generate
   */
  private async asyncGenerate() {
    this.requestInProgress = true;
    const prompt = this.uiChatInput.value;
    if (prompt == "") {
      this.requestInProgress = false;
      return;
    }

    this.appendUserMessage(prompt);
    this.uiChatInput.value = "";
    this.uiChatInput.setAttribute("placeholder", "Generating...");

    this.appendMessage("left", "");
    this.chatHistory.push({ role: "user", content: prompt });

    try {
      let curMessage = "";
      let usage: webllm.CompletionUsage | undefined = undefined;
      const completion = await this.engine.chat.completions.create({
        stream: true,
        messages: this.chatHistory,
        stream_options: { include_usage: true },
        max_tokens: 256,
        stop: ["Human:", "Assistant:"],
      });
      // TODO(Charlie): Processing of � requires changes
      for await (const chunk of completion) {
        const curDelta = chunk.choices[0]?.delta.content;
        if (curDelta) {
          curMessage += curDelta;
        }
        this.updateLastMessage("left", curMessage);
        if (chunk.usage) {
          usage = chunk.usage;
        }
      }
      if (usage) {
        this.uiChatInfoLabel.innerHTML =
          `prompt_tokens: ${usage.prompt_tokens}, ` +
          `completion_tokens: ${usage.completion_tokens}, ` +
          `prefill: ${usage.extra.prefill_tokens_per_s.toFixed(
            4
          )} tokens/sec, ` +
          `decoding: ${usage.extra.decode_tokens_per_s.toFixed(4)} tokens/sec`;
      }
      const finalMessage = await this.engine.getMessage();
      this.updateLastMessage("left", finalMessage); // TODO: Remove this after � issue is fixed
      this.chatHistory.push({ role: "assistant", content: finalMessage });
    } catch (err) {
      this.appendMessage("error", "Generate error, " + err.toString());
      console.log(err.stack);
      await this.unloadChat();
    }
    this.uiChatInput.setAttribute("placeholder", "Enter your message...");
    this.requestInProgress = false;
  }
}

const useWebWorker = appConfig.use_web_worker;
let engine: webllm.MLCEngineInterface;

// Here we do not use `CreateMLCEngine()` but instantiate an engine that is not loaded with model
if (useWebWorker) {
  engine = new webllm.WebWorkerMLCEngine(
    new Worker(new URL("./worker.ts", import.meta.url), { type: "module" }),
    { appConfig }
  );
} else {
  engine = new webllm.MLCEngine({ appConfig });
}
ChatUI.CreateAsync(engine);
