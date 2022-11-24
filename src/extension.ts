import DeepSource, { Occurence } from "deepsource-node";
import git from "simple-git";
import path = require("path");
import * as vscode from "vscode";
// @ts-ignore
import * as VSCodeCache from "vscode-cache";

type RepoInfo = {
  userName: string;
  repoName: string;
};

const languagesSupported = [
  "javascript",
  "typescript",
  "jsx",
  "tsx",
  "python",
  "go",
  "sql",
  "vue",
  "rust",
  "ruby",
  "php",
  "java",
];

/**
 * @param repoDir Path to a git repository
 * @returns username and repo name
 */
async function getRepoAndUserName(repoDir: string): Promise<RepoInfo | null> {
  const gitRepo = git(repoDir);
  const isRepo = await gitRepo.checkIsRepo();
  if (!isRepo) return null;

  const urlInConfig = await gitRepo.getConfig("remote.origin.url");
  const remoteUrl = urlInConfig.value;
  const githubUserAndRepoNameRegex = /([\w-]+)\/([\w-]+)\.git/;
  const matches = remoteUrl?.match(githubUserAndRepoNameRegex);
  if (matches && matches.length == 3) {
    const userName = matches[1];
    const repoName = matches[2];
    return { userName, repoName };
  }

  return null;
}

function getPATFromUser(): Thenable<string | undefined> {
  return vscode.window.showInputBox({
    title: "Personal access token",
    password: true,
  });
}

type DiagnosticMap = Map<string, vscode.Diagnostic[]>;

let deepSource: DeepSource | undefined;
let userName: string | undefined;
let repoName: string | undefined;

function getDiagnosticMap(occurrences: Occurence[]): DiagnosticMap {
  const diagnosticMap: DiagnosticMap = new Map();

  for (const occurrence of occurrences) {
    const filePath = occurrence.path;
    const { issue } = occurrence;
    const { endLine, beginLine, endColumn, beginColumn } = occurrence;
    const startPos = new vscode.Position(beginLine, beginColumn);
    const endPos = new vscode.Position(endLine, endColumn);
    const range = new vscode.Range(startPos, endPos);

    const diagnostic = new vscode.Diagnostic(
      range,
      issue.title,
      vscode.DiagnosticSeverity.Warning
    );

    if (diagnosticMap.has(filePath)) {
      const diags = diagnosticMap.get(filePath) as vscode.Diagnostic[];
      diags.push(diagnostic);
    } else {
      diagnosticMap.set(filePath, [diagnostic]);
    }
  }

  return diagnosticMap;
}

async function fetchAnalysisReport(): Promise<Occurence[] | null> {
  if (!(deepSource && userName && repoName)) return null;
  const repo = await deepSource.getRepo(repoName, userName);

  if (!repo) {
    vscode.window.showErrorMessage(
      "Unable to fetch repository information from DeepSource.\n" +
        "Please ensure the access token is correct and analysis is enabled on www.deepsource.io"
    );
    return null;
  }

  const latestRunID = repo.runIds[0];
  if (!latestRunID) {
    vscode.window.showErrorMessage("Unable to fetch fetch analysis data.");
    return null;
  }

  const checksOnRepo = await deepSource.getChecksByRunId(latestRunID);
  if (!checksOnRepo) {
    vscode.window.showErrorMessage(
      `Unable to fetch data for run: ${latestRunID}`
    );
    return null;
  }

  const occurrences = checksOnRepo.map((check) => check.occurrences).flat();
  return occurrences;
}


export function activate(context: vscode.ExtensionContext) {
  const { workspaceFolders } = vscode.workspace;
  const workspaceDirPath = workspaceFolders?.[0].uri.path;

  if (!workspaceDirPath) {
    throw new Error("Unable to resolve current workspace path");
  }

  const cache = new VSCodeCache(context);

  getRepoAndUserName(workspaceDirPath).then((repoInfo) => {
    // current workspace is not a git repository, and cannot be analysed.
    if (!repoInfo) return;
    userName = repoInfo.userName;
    repoName = repoInfo.repoName;
  });

  const disposable = vscode.commands.registerCommand(
    "extension.getAnalysisReport",
    () => {
      if (deepSource) {
        fetchAnalysisReport();
        return;
      }

      if (cache.has("personal-access-token")) {
        const accessToken = cache.get("personal-access-token");
        deepSource = new DeepSource(accessToken);
        cache.put("PAT", accessToken);
        fetchAnalysisReport();
      } else {
        getPATFromUser().then((pat) => {
          if (!pat) return;
          deepSource = new DeepSource(pat);
          cache.put("PAT", pat);
          fetchAnalysisReport();
        });
      }
    }
  );

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (!editor) return;
      vscode.window.showInformationMessage("file changed");
    })
  );

  context.subscriptions.push(disposable);
}
