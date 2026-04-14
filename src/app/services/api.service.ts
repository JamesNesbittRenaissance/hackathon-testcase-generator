import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

@Injectable({
  providedIn: 'root'
})
export class ApiService {
  private http = inject(HttpClient);
  private baseUrl = 'http://localhost:3000/api';

  async getWorkItem(workItemId: number, project: string) {
    return firstValueFrom(
      this.http.get<any>(`${this.baseUrl}/workitem/${workItemId}`, {
        params: { project }
      })
    );
  }

  async analyzeWithClaude(
    data: any,
    analysisType: 'testCases' | 'impactAnalysis' | 'documentation' | 'pbiQualityAssessment',
    userFeedback?: string,
    previousTestCases?: string,
    additionalContext?: string,
    generateAll?: boolean,
    onProgress?: (message: string) => void
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      // Create a fetch request with SSE support
      fetch(`${this.baseUrl}/analyze`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          data,
          analysisType,
          userFeedback,
          previousTestCases,
          additionalContext,
          generateAll
        })
      })
      .then(response => {
        const reader = response.body?.getReader();
        const decoder = new TextDecoder();

        if (!reader) {
          reject(new Error('Failed to get response stream'));
          return;
        }

        let buffer = ''; // Buffer for incomplete lines

        const readStream = () => {
          reader.read().then(({ done, value }) => {
            if (done) {
              console.log('SSE stream ended');
              return;
            }

            // Decode chunk and add to buffer
            buffer += decoder.decode(value, { stream: true });

            // Split by double newline (SSE message separator)
            const messages = buffer.split('\n\n');

            // Keep the last incomplete message in the buffer
            buffer = messages.pop() || '';

            // Process complete messages
            for (const message of messages) {
              const lines = message.split('\n');
              for (const line of lines) {
                if (line.startsWith('data: ')) {
                  try {
                    const data = JSON.parse(line.substring(6));
                    console.log('SSE data received:', data.type, data);

                    if (data.type === 'progress' && onProgress) {
                      onProgress(data.message);
                    } else if (data.type === 'complete') {
                      console.log('SSE complete event received, resolving promise');
                      resolve(data);
                      return;
                    } else if (data.type === 'error') {
                      console.error('SSE error event received:', data.error);
                      reject(new Error(data.error || 'An error occurred'));
                      return;
                    }
                  } catch (e) {
                    console.error('Failed to parse SSE data:', e, 'Line:', line);
                  }
                }
              }
            }

            readStream();
          }).catch(err => {
            console.error('Stream read error:', err);
            reject(err);
          });
        };

        readStream();
      })
      .catch(reject);
    });
  }

  async getSettings() {
    return firstValueFrom(
      this.http.get<any>(`${this.baseUrl}/settings`)
    );
  }

  async saveSettings(settings: any) {
    // Settings are managed via environment variables now
    return { success: true };
  }

  async getProjectInfo(project: string) {
    return firstValueFrom(
      this.http.get<any>(`${this.baseUrl}/project-info`, {
        params: { project }
      })
    );
  }

  async getTestPlans(project: string) {
    return firstValueFrom(
      this.http.get<any>(`${this.baseUrl}/test-plans`, {
        params: { project }
      })
    );
  }

  async getTestSuites(project: string, planId: number) {
    return firstValueFrom(
      this.http.get<any>(`${this.baseUrl}/test-suites`, {
        params: { project, planId: planId.toString() }
      })
    );
  }

  async createTestPlan(project: string, name: string, areaPath: string, iteration: string) {
    return firstValueFrom(
      this.http.post<any>(`${this.baseUrl}/test-plans`, {
        project,
        name,
        areaPath,
        iteration
      })
    );
  }

  async createTestSuite(
    project: string,
    planId: number,
    name: string,
    suiteType: string,
    parentSuiteId: number,
    requirementId?: number
  ) {
    return firstValueFrom(
      this.http.post<any>(`${this.baseUrl}/test-suites`, {
        project,
        planId,
        name,
        suiteType,
        parentSuiteId,
        requirementId
      })
    );
  }

  async exportTestCases(
    project: string,
    planId: number,
    suiteId: number,
    testCasesMarkdown: string,
    pbiId?: number
  ) {
    return firstValueFrom(
      this.http.post<any>(`${this.baseUrl}/export-test-cases`, {
        project,
        planId,
        suiteId,
        testCasesMarkdown,
        pbiId
      })
    );
  }
}
