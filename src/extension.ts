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

const { workspaceFolders } = vscode.workspace;
const workspaceDirPath = workspaceFolders?.[0].uri.path;

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
let diagnosticsInFile: DiagnosticMap = new Map();

function getDiagnosticMap(
  workspaceDirPath: string,
  occurrences: Occurence[]
): DiagnosticMap {
  const diagnosticMap: DiagnosticMap = new Map();

  for (const occurrence of occurrences) {
    const filePath = path.join(workspaceDirPath, occurrence.path);
    const { issue } = occurrence;
    const { endLine, beginLine, endColumn, beginColumn } = occurrence;
    const beginCol = beginColumn > 0 ? beginColumn - 1 : beginColumn;
    const startPos = new vscode.Position(beginLine - 1, beginCol);
    const endPos = new vscode.Position(endLine - 1, endColumn);
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

  const allIssuesInRepo = await deepSource.getAllIssuesInRepo(
    repoName,
    userName
  );

  if (!allIssuesInRepo) {
    vscode.window.showErrorMessage(
      "Unable to fetch data for repository.\n" +
        "Please ensure analysis is activated on https://deepsource.com."
    );
    return null;
  }

  return allIssuesInRepo;
}

/**
 * Assuming that the DeepSource API has instantiated, fetch the issues in the workspace,
 * then display issues in appropriate files.
 * @return `true` if diagnostics were calculated successfully.
 */
async function calculateDiagnostics(
  workspaceDirPath: string
): Promise<boolean> {
  const occurrences = await fetchAnalysisReport();
  if (!occurrences) return false;
  diagnosticsInFile = getDiagnosticMap(workspaceDirPath, occurrences);
  vscode.window.showErrorMessage(
    "Successfully fetched issues from deepsource.io"
  );
  return true;
}

export function activate(context: vscode.ExtensionContext) {
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

  const diagnosticCollection =
    vscode.languages.createDiagnosticCollection("deepsource");

  cache.flush();

  const disposable = vscode.commands.registerCommand(
    "extension.getAnalysisReport",
    () => {
      if (deepSource) {
        calculateDiagnostics(workspaceDirPath);
        return;
      }

      if (cache.has("personal-access-token")) {
        const accessToken = cache.get("personal-access-token");
        deepSource = new DeepSource(accessToken);
        cache.put("personal-access-token", accessToken);
        calculateDiagnostics(workspaceDirPath);
      } else {
        getPATFromUser().then((pat) => {
          if (!pat) return;
          deepSource = new DeepSource(pat);
          cache.put("personal-access-token", pat);
          calculateDiagnostics(workspaceDirPath).then((success) => {
            console.log("incorrect PAT");
            if (!success) cache.forget("personal-access-token");
          });
        });
      }
    }
  );

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (!editor) return;

      const { document } = editor;
      const filePath = document.uri.fsPath;
      vscode.window.showInformationMessage(filePath);
      diagnosticCollection.clear();

      if (diagnosticsInFile.has(filePath)) {
        diagnosticCollection.set(document.uri, diagnosticsInFile.get(filePath));
      }
    })
  );

  context.subscriptions.push(disposable);
}
