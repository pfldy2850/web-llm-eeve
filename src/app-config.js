import { prebuiltAppConfig } from "@mlc-ai/web-llm";

const modelLibURLPrefix =
  "https://raw.githubusercontent.com/pfldy2850/web-llm-eeve/main/models/";

export default {
  useIndexedDBCache: false,
  model_list: [
    {
      model:
        "https://huggingface.co/pfldy2850/EEVE-Korean-Instruct-10.8B-v1.0-q4f16_1-MLC",
      model_id: "EEVE-Korean-Instruct-10.8B-v1.0-q4f16_1",
      model_lib:
        modelLibURLPrefix +
        "/EEVE-Korean-Instruct-10.8B-v1.0/EEVE-Korean-Instruct-10.8B-v1.0-q4f16_1-webgpu.wasm",
      vram_required_MB: 6108.76,
      overrides: {
        context_window_size: 1024,
      },
      low_resource_required: true,
    },
  ],
  use_web_worker: true,
};
