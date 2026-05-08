/**
 * backlog/client.ts （更新版）
 * カスタムフィールド更新・課題タイプ別取得を追加
 */
import axios, { AxiosInstance } from "axios";
import fs from "fs";

export interface BacklogIssue {
  id: number;
  issueKey: string;
  summary: string;
  status: { id: number; name: string };
  issueType?: { id: number; name: string };
  assignee?: { name: string };
  customFields?: Array<{ fieldId: number; value: string | null }>;
  dueDate?: string | null;
  created: string;
  updated: string;
}

export interface BacklogStatus {
  id: number;
  name: string;
  color?: string;
  displayOrder?: number;
}

export interface BacklogIssueType {
  id: number;
  name: string;
  color?: string;
  displayOrder?: number;
}

export interface BacklogCustomField {
  id: number;
  name: string;
  typeId?: number;
  description?: string;
  required?: boolean;
  applicableIssueTypes?: Array<{ id: number; name: string }>;
}

export interface CreateBacklogCustomFieldParams {
  name: string;
  typeId: number;
  description?: string;
  required?: boolean;
  applicableIssueTypeIds?: number[];
}

export interface UpdateBacklogCustomFieldParams {
  name?: string;
  description?: string;
  applicableIssueTypeIds?: number[];
}

export interface CreateBacklogIssueTypeParams {
  name: string;
  color?: string;
}

export interface UpdateIssueParams {
  summary?: string;
  description?: string;
  dueDate?: string;
  customFields?: Record<string, string>;
}

export interface CreateIssueParams {
  summary: string;
  description: string;
  issueTypeId?: number;
  priorityId?: number;
  dueDate?: string;
  customFields?: Record<string, string>;
  attachmentIds?: number[];
}

function formatBacklogError(error: unknown, context: string): Error {
  if (!axios.isAxiosError(error)) {
    return new Error(`${context}: ${error instanceof Error ? error.message : String(error)}`);
  }

  const status = error.response?.status;
  const responseErrors = Array.isArray(error.response?.data?.errors)
    ? error.response?.data?.errors
    : [];
  const responseBody = error.response?.data;

  const detailedMessages = responseErrors
    .map((item: any) => {
      const field = item?.info?.key ? ` [${item.info.key}]` : "";
      const message = String(item?.message ?? "").trim();
      if (!message) return null;
      return `${message}${field}`;
    })
    .filter((value: string | null): value is string => Boolean(value));

  const base = `${context}${status ? ` (status ${status})` : ""}`;
  if (detailedMessages.length > 0) {
    return new Error(`${base}: ${detailedMessages.join(" / ")}`);
  }
  if (responseBody) {
    return new Error(`${base}: ${JSON.stringify(responseBody)}`);
  }
  return new Error(`${base}: ${error.message}`);
}

export class BacklogClient {
  private http: AxiosInstance;
  private projectKey: string;

  constructor() {
    const space = process.env.BACKLOG_SPACE!;
    const apiKey = process.env.BACKLOG_API_KEY!;
    this.projectKey = process.env.BACKLOG_PROJECT_KEY!;
    this.http = axios.create({
      baseURL: `https://${space}.backlog.com/api/v2`,
      params: { apiKey },
      timeout: 10_000,
    });
  }

  async createIssue(params: CreateIssueParams): Promise<BacklogIssue> {
    const customFieldParams: Record<string, string> = {};
    if (params.customFields) {
      for (const [fieldId, value] of Object.entries(params.customFields)) {
        customFieldParams[`customField_${fieldId}`] = value;
      }
    }
    const payload = {
      projectId: await this.getProjectId(),
      summary: params.summary,
      issueTypeId: params.issueTypeId ?? (await this.getDefaultIssueTypeId()),
      priorityId: params.priorityId ?? 2,
      description: params.description,
      dueDate: params.dueDate,
      ...customFieldParams,
    };
    const form = new URLSearchParams();
    for (const [key, value] of Object.entries(payload)) {
      if (value === undefined || value === null || value === "") continue;
      form.append(key, String(value));
    }
    for (const attachmentId of params.attachmentIds ?? []) {
      form.append("attachmentId[]", String(attachmentId));
    }

    try {
      const { data } = await this.http.post<BacklogIssue>("/issues", form, {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      });
      console.log(`[Backlog] 課題作成: ${data.issueKey}`);
      return data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const responseErrors = Array.isArray(error.response?.data?.errors)
          ? error.response?.data?.errors
          : [];
        console.error("[Backlog] 課題作成失敗 payload=", payload);
        console.error("[Backlog] 課題作成失敗 errors=", responseErrors);
      }
      throw formatBacklogError(error, "Backlog課題作成に失敗しました");
    }
  }

  async getIssue(issueKey: string): Promise<BacklogIssue> {
    const { data } = await this.http.get<BacklogIssue>(`/issues/${issueKey}`);
    return data;
  }

  async getRecentIssues(count = 10): Promise<BacklogIssue[]> {
    return this.listIssues({ count });
  }

  async listIssues(params?: {
    count?: number;
    offset?: number;
    statusId?: number[];
    issueTypeId?: number[];
  }): Promise<BacklogIssue[]> {
    const { data } = await this.http.get<BacklogIssue[]>("/issues", {
      params: {
        projectId: [await this.getProjectId()],
        count: params?.count ?? 100,
        offset: params?.offset ?? 0,
        sort: "updated",
        order: "desc",
        statusId: params?.statusId,
        issueTypeId: params?.issueTypeId,
      },
    });
    return data;
  }

  async listAllIssues(params?: {
    statusId?: number[];
    issueTypeId?: number[];
  }): Promise<BacklogIssue[]> {
    const all: BacklogIssue[] = [];
    const pageSize = 100;
    let offset = 0;

    while (true) {
      const page = await this.listIssues({
        count: pageSize,
        offset,
        statusId: params?.statusId,
        issueTypeId: params?.issueTypeId,
      });
      all.push(...page);
      if (page.length < pageSize) break;
      offset += pageSize;
    }

    return all;
  }

  async addComment(issueKey: string, content: string): Promise<void> {
    try {
      await this.http.post(`/issues/${issueKey}/comments`, { content });
      console.log(`[Backlog] コメント投稿: ${issueKey}`);
    } catch (error) {
      throw formatBacklogError(error, `Backlogコメント投稿に失敗しました (${issueKey})`);
    }
  }

  async addCommentWithAttachments(issueKey: string, content: string, attachmentIds: number[] = []): Promise<void> {
    const form = new URLSearchParams();
    form.append("content", content);
    for (const attachmentId of attachmentIds) {
      form.append("attachmentId[]", String(attachmentId));
    }
    try {
      await this.http.post(`/issues/${issueKey}/comments`, form, {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      });
      console.log(`[Backlog] コメント投稿(添付付き): ${issueKey}`);
    } catch (error) {
      throw formatBacklogError(error, `Backlogコメント投稿(添付付き)に失敗しました (${issueKey})`);
    }
  }

  async uploadAttachment(filePath: string, filename: string): Promise<number> {
    const fetchFn: any = (globalThis as any).fetch;
    const FormDataCtor: any = (globalThis as any).FormData;
    const BlobCtor: any = (globalThis as any).Blob;
    const apiKey = process.env.BACKLOG_API_KEY!;
    const space = process.env.BACKLOG_SPACE!;

    if (!fetchFn || !FormDataCtor || !BlobCtor) {
      throw new Error("Backlog 添付アップロードに必要な Web API が利用できません。");
    }

    const form = new FormDataCtor();
    form.append("file", new BlobCtor([fs.readFileSync(filePath)]), filename);

    const response = await fetchFn(`https://${space}.backlog.com/api/v2/space/attachment?apiKey=${apiKey}`, {
      method: "POST",
      body: form,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Backlog 添付アップロード失敗: ${response.status} ${errorText}`);
    }

    const data = await response.json() as Array<{ id: number }>;
    const attachmentId = data[0]?.id;
    if (!attachmentId) {
      throw new Error("Backlog 添付アップロード結果から attachment id を取得できませんでした。");
    }

    return attachmentId;
  }

  async updateStatus(issueKey: string, statusId: number): Promise<void> {
    try {
      await this.http.patch(`/issues/${issueKey}`, { statusId });
    } catch (error) {
      throw formatBacklogError(error, `Backlogステータス更新に失敗しました (${issueKey})`);
    }
  }

  /** カスタムフィールド単体更新（MG消化額の累積更新等に使用） */
  async updateCustomField(issueKey: string, fieldId: number, value: string): Promise<void> {
    try {
      await this.http.patch(`/issues/${issueKey}`, { [`customField_${fieldId}`]: value });
      console.log(`[Backlog] フィールド更新: ${issueKey} / field${fieldId}=${value}`);
    } catch (error) {
      throw formatBacklogError(error, `Backlogカスタム項目更新に失敗しました (${issueKey}, field:${fieldId})`);
    }
  }

  async updateIssue(issueKey: string, params: UpdateIssueParams): Promise<void> {
    const payload: Record<string, string> = {};
    if (params.summary) {
      payload.summary = params.summary;
    }
    if (params.description) {
      payload.description = params.description;
    }
    if (params.dueDate) {
      payload.dueDate = params.dueDate;
    }
    if (params.customFields) {
      for (const [fieldId, value] of Object.entries(params.customFields)) {
        if (!fieldId || value == null || value === "") continue;
        payload[`customField_${fieldId}`] = value;
      }
    }
    if (Object.keys(payload).length === 0) return;
    try {
      await this.http.patch(`/issues/${issueKey}`, payload);
      console.log(`[Backlog] 課題更新: ${issueKey}`);
    } catch (error) {
      throw formatBacklogError(error, `Backlog課題更新に失敗しました (${issueKey})`);
    }
  }

  async listIssueTypes(): Promise<BacklogIssueType[]> {
    const { data } = await this.http.get<BacklogIssueType[]>(`/projects/${this.projectKey}/issueTypes`);
    return data;
  }

  async findIssueTypeIdByName(name: string): Promise<number | undefined> {
    const issueTypes = await this.listIssueTypes();
    return issueTypes.find((issueType) => issueType.name === name)?.id;
  }

  async listStatuses(): Promise<BacklogStatus[]> {
    const { data } = await this.http.get<BacklogStatus[]>(`/projects/${this.projectKey}/statuses`);
    return data;
  }

  async listCustomFields(): Promise<BacklogCustomField[]> {
    const projectId = await this.getProjectId();
    const { data } = await this.http.get<BacklogCustomField[]>(`/projects/${projectId}/customFields`);
    return data;
  }

  async updateCustomFieldDefinition(
    fieldId: number,
    params: UpdateBacklogCustomFieldParams,
  ): Promise<BacklogCustomField> {
    const projectId = await this.getProjectId();
    const form = new URLSearchParams();
    if (params.name) form.append("name", params.name);
    if (params.description !== undefined) form.append("description", params.description);
    for (const issueTypeId of params.applicableIssueTypeIds ?? []) {
      form.append("applicableIssueTypes[]", String(issueTypeId));
    }

    const { data } = await this.http.patch<BacklogCustomField>(
      `/projects/${projectId}/customFields/${fieldId}`,
      form,
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } },
    );
    return data;
  }

  async deleteCustomField(fieldId: number): Promise<void> {
    const projectId = await this.getProjectId();
    try {
      await this.http.delete(`/projects/${projectId}/customFields/${fieldId}`);
    } catch (error) {
      if (axios.isAxiosError(error)) {
        console.error("[Backlog] カスタム属性削除失敗", {
          fieldId,
          status: error.response?.status ?? null,
          errors: error.response?.data?.errors ?? null,
        });
      }
      throw error;
    }
  }

  async addCustomField(params: CreateBacklogCustomFieldParams): Promise<BacklogCustomField> {
    const projectId = await this.getProjectId();
    const form = new URLSearchParams();
    form.append("name", params.name);
    form.append("typeId", String(params.typeId));
    if (params.description !== undefined) form.append("description", params.description);
    if (params.required !== undefined) form.append("required", params.required ? "true" : "false");
    for (const issueTypeId of params.applicableIssueTypeIds ?? []) {
      form.append("applicableIssueTypes[]", String(issueTypeId));
    }

    try {
      const { data } = await this.http.post<BacklogCustomField>(
        `/projects/${projectId}/customFields`,
        form,
        { headers: { "Content-Type": "application/x-www-form-urlencoded" } },
      );
      return data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        console.error("[Backlog] カスタム属性作成失敗", {
          name: params.name,
          typeId: params.typeId,
          required: params.required ?? null,
          applicableIssueTypeIds: params.applicableIssueTypeIds ?? [],
          status: error.response?.status ?? null,
          errors: error.response?.data?.errors ?? null,
        });
      }
      throw error;
    }
  }

  async addStatus(params: { name: string; color?: string }): Promise<BacklogStatus> {
    const projectId = await this.getProjectId();
    const form = new URLSearchParams();
    form.append("name", params.name);
    if (params.color) form.append("color", params.color);

    const { data } = await this.http.post<BacklogStatus>(
      `/projects/${projectId}/statuses`,
      form,
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } },
    );
    return data;
  }

  async addIssueType(params: CreateBacklogIssueTypeParams): Promise<BacklogIssueType> {
    const projectId = await this.getProjectId();
    const form = new URLSearchParams();
    form.append("name", params.name);
    if (params.color) form.append("color", params.color);

    try {
      const { data } = await this.http.post<BacklogIssueType>(
        `/projects/${projectId}/issueTypes`,
        form,
        { headers: { "Content-Type": "application/x-www-form-urlencoded" } },
      );
      return data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        console.error("[Backlog] 課題タイプ作成失敗", {
          name: params.name,
          color: params.color ?? null,
          status: error.response?.status ?? null,
          errors: error.response?.data?.errors ?? null,
        });
      }
      throw error;
    }
  }

  async updateStatusDefinition(statusId: number, params: { name?: string; color?: string }): Promise<BacklogStatus> {
    const projectId = await this.getProjectId();
    const form = new URLSearchParams();
    if (params.name) form.append("name", params.name);
    if (params.color) form.append("color", params.color);

    const { data } = await this.http.patch<BacklogStatus>(
      `/projects/${projectId}/statuses/${statusId}`,
      form,
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } },
    );
    return data;
  }

  async updateStatusDisplayOrder(statusIds: number[]): Promise<BacklogStatus[]> {
    const projectId = await this.getProjectId();
    const form = new URLSearchParams();
    for (const statusId of statusIds) {
      form.append("statusId[]", String(statusId));
    }

    const { data } = await this.http.patch<BacklogStatus[]>(
      `/projects/${projectId}/statuses/updateDisplayOrder`,
      form,
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } },
    );
    return data;
  }

  async findStatusIdByName(name: string): Promise<number | undefined> {
    const statuses = await this.listStatuses();
    return statuses.find((status) => status.name === name)?.id;
  }

  private _projectId?: number;
  private async getProjectId(): Promise<number> {
    if (this._projectId) return this._projectId;
    const { data } = await this.http.get(`/projects/${this.projectKey}`);
    this._projectId = data.id;
    return data.id;
  }
  private async getDefaultIssueTypeId(): Promise<number> {
    const { data } = await this.http.get(`/projects/${this.projectKey}/issueTypes`);
    return data[0]?.id ?? 1;
  }
}

export const backlog = new BacklogClient();
