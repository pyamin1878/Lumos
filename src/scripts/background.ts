import { StringOutputParser } from "@langchain/core/output_parsers";
import { PromptTemplate } from "@langchain/core/prompts";
import { RunnableSequence, RunnablePassthrough } from "@langchain/core/runnables";
import { RecursiveCharacterTextSplitter } from "langchain/text_splitter";
import { formatDocumentsAsString } from "langchain/util/document";
import { MemoryVectorStore } from "langchain/vectorstores/memory";
import { OllamaEmbeddings } from "@langchain/community/embeddings/ollama";
import { Ollama } from "@langchain/community/llms/ollama";
import {
  DEFAULT_CONTENT_CONFIG,
  DEFAULT_HOST,
  DEFAULT_MODEL,
  DEFAULT_VECTOR_STORE_TTL_MINS,
} from "../pages/Options";
import { ContentConfig } from "../contentConfig";


interface VectorStoreMetadata {
  vectorStore: MemoryVectorStore
  createdAt: number
}

// map of url to vector store metadata
const vectorStoreMap = new Map<string, VectorStoreMetadata>();

var context = "";

chrome.runtime.onMessage.addListener(async function (request) {
  if (request.prompt) {
    const prompt = request.prompt;
    const url = request.url;
    const skipCache = Boolean(request.skipCache);
    console.log(`Received url: ${url}`);
    console.log(`Received prompt: ${prompt}`);

    // get Lumos options
    const lumosOptions: {
      ollamaModel: string,
      ollamaHost: string,
      contentConfig: ContentConfig,
      vectorStoreTTLMins: number,
    } = await new Promise((resolve, reject) => {
      chrome.storage.local.get(["selectedModel", "selectedHost", "selectedConfig", "selectedVectorStoreTTLMins"], (data) => {
        if (chrome.runtime.lastError) {
          reject(chrome.runtime.lastError);
        } else {
          resolve({
            ollamaModel: data.selectedModel || DEFAULT_MODEL,
            ollamaHost: data.selectedHost || DEFAULT_HOST,
            contentConfig: JSON.parse(data.selectedConfig || DEFAULT_CONTENT_CONFIG) as ContentConfig,
            vectorStoreTTLMins: parseInt(data.selectedVectorStoreTTLMins, 10) || DEFAULT_VECTOR_STORE_TTL_MINS,
          });
        }
      });
    });

    // delete all vector stores that are expired
    vectorStoreMap.forEach((vectorStoreMetdata: VectorStoreMetadata, url: string) => {
      if (Date.now() - vectorStoreMetdata.createdAt! > lumosOptions.vectorStoreTTLMins * 60 * 1000) {
        vectorStoreMap.delete(url);
        console.log(`Deleting vector store for url: ${url}`);
      }
    });

    // get default content config
    const config = lumosOptions.contentConfig["default"];
    const chunkSize = !!request.chunkSize ? request.chunkSize : config.chunkSize;
    const chunkOverlap = !!request.chunkOverlap ? request.chunkOverlap : config.chunkOverlap;
    console.log(`Received chunk size: ${chunkSize} and chunk overlap: ${chunkOverlap}`);

    // create model
    const model = new Ollama({
      baseUrl: lumosOptions.ollamaHost,
      model: lumosOptions.ollamaModel,
    });

    // create prompt template
    const template = `Use only the following context when answering the question. Don't use any other knowledge.\n\nBEGIN CONTEXT\n\n{filtered_context}\n\nEND CONTEXT\n\nQuestion: {question}\n\nAnswer: `;
    const formatted_prompt = new PromptTemplate({
      inputVariables: ["filtered_context", "question"],
      template,
    });

    // check if vector store already exists for url
    var vectorStore: MemoryVectorStore;

    if (!skipCache && vectorStoreMap.has(url)) {
      // retrieve existing vector store
      console.log(`Retrieving existing vector store for url: ${url}`);
      vectorStore = vectorStoreMap.get(url)?.vectorStore!;
    } else {
      // create new vector store
      console.log(`Creating ${skipCache ? "temporary" : "new"} vector store for url: ${url}`);

      // split page content into overlapping documents
      const splitter = new RecursiveCharacterTextSplitter({
        chunkSize: chunkSize,
        chunkOverlap: chunkOverlap,
      });
      const documents = await splitter.createDocuments([context]);

      // load documents into vector store
      vectorStore = await MemoryVectorStore.fromDocuments(
        documents,
        new OllamaEmbeddings({
          baseUrl: lumosOptions.ollamaHost,
          model: lumosOptions.ollamaModel,
        }),
      );

      // store vector store in vector store map
      if (!skipCache) {
        vectorStoreMap.set(url, {
          vectorStore: vectorStore,
          createdAt: Date.now(),
        });
      }
    }

    const retriever = vectorStore.asRetriever();

    // create chain
    const chain = RunnableSequence.from([
      {
        filtered_context: retriever.pipe(formatDocumentsAsString),
        question: new RunnablePassthrough(),
      },
      formatted_prompt,
      model,
      new StringOutputParser(),
    ]);
    
    // stream response chunks
    const stream = await chain.stream(prompt);
    for await (const chunk of stream) {
      chrome.runtime.sendMessage({ chunk: chunk });
    }
    chrome.runtime.sendMessage({ done: true });
  }
  if (request.context) {
    context = request.context;
    console.log(`Received context: ${context}`);
  }
});

const keepAlive = () => {
  setInterval(chrome.runtime.getPlatformInfo, 20e3);
  console.log("Keep alive...");
}
chrome.runtime.onStartup.addListener(keepAlive);
keepAlive();
