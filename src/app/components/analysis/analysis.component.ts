import { Component, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { ApiService } from '../../services/api.service';
import { marked } from 'marked';
import { TestPlanExportModalComponent } from '../test-plan-export-modal/test-plan-export-modal.component';

interface AnalysisResult {
  type: string;
  content: string;
  htmlContent: SafeHtml;
  preambleHtml?: SafeHtml; // Content before TC-001 (test suite summary, quality assessment, analysis, etc.)
  mainTestCasesHtml?: SafeHtml; // Main test cases content
  additionalTestsHtml?: SafeHtml; // Additional tests if any
  timestamp: Date;
  qualityScore?: string;
  qualityScoreHtml?: SafeHtml;
  iterations?: number;
  isFocusedGeneration?: boolean; // True if this was Happy Path + Top 5 only
}

interface QualityAssessment {
  quality_category: 'GOOD' | 'OK' | 'BAD';
  confidence_level: 'HIGH' | 'MEDIUM' | 'LOW';
  overall_score: number;
  category_scores: {
    user_story_clarity: number;
    acceptance_criteria: number;
    business_value: number;
    technical_requirements: number;
    definition_of_done: number;
    context_and_detail: number;
  };
  missing_keywords: string[];
  improvement_points: Array<{
    label: string;
    prompt: string;
  }>;
  summary: string;
}

@Component({
  selector: 'app-analysis',
  standalone: true,
  imports: [CommonModule, FormsModule, TestPlanExportModalComponent],
  templateUrl: './analysis.component.html',
  styleUrl: './analysis.component.scss'
})
export class AnalysisComponent implements OnDestroy {
  itemId: string = '';
  project: string = '';

  loading: boolean = false;
  error: string = '';
  itemData: any = null;
  qualityAssessment: QualityAssessment | null = null;
  qualityAssessmentLoading: boolean = false;
  qualityAssessmentError: string = '';
  improvementResponses: Record<number, string> = {};
  consolidatedResponse: string = '';
  showContextForm: boolean = false;
  showJustification: boolean = false;

  analysisResults: AnalysisResult[] = [];
  userFeedback: string = '';
  showExportModal: boolean = false;
  exportSuccess: string = '';
  showAdditionalInfo: boolean = false;
  showAdditionalTests: boolean = false;

  // Progress tracking
  generatingDots: string = '';
  generatingInterval: any = null;
  progressMessage: string = '';

  constructor(
    private apiService: ApiService,
    private sanitizer: DomSanitizer
  ) {
    this.loadDefaultSettings();
  }

  async loadDefaultSettings() {
    try {
      const settings = await this.apiService.getSettings();
      if (settings.defaultProject) {
        this.project = settings.defaultProject;
      }
    } catch (error: any) {
      console.error('Failed to load settings:', error);
    }
  }

  async fetchItem() {
    if (!this.itemId || !this.project) {
      this.error = 'Please enter a PBI ID and project';
      return;
    }

    this.loading = true;
    this.error = '';
    this.itemData = null;

    try {
      const result = await this.apiService.getWorkItem(parseInt(this.itemId), this.project);

      if (result.success) {
        this.itemData = result.data;

        // Validate work item data before proceeding to Agent calls
        if (!this.itemData?.fields || Object.keys(this.itemData.fields).length === 0) {
          this.error = 'Retrieved work item has no fields. Please check your permissions for this item.';
          this.loading = false;
          return;
        }

        // Check for essential fields
        if (!this.itemData.fields['System.Title']) {
          this.error = 'Work item is missing essential data. You may not have sufficient permissions to view this item.';
          this.loading = false;
          return;
        }

        // Auto-assess PBI quality when fetched
        await this.assessPBIQuality();
      } else {
        this.error = result.error || 'Failed to fetch PBI';
      }
    } catch (error: any) {
      // For HTTP errors, the backend error message is in error.error.error
      // The error object structure is: { error: { success: false, error: "our message" } }
      this.error = error.error?.error || error.message || 'An error occurred';
      console.error('Fetch error:', error);
    } finally {
      this.loading = false;
    }
  }

  async assessPBIQuality() {
    this.qualityAssessmentLoading = true;
    this.qualityAssessmentError = '';
    this.qualityAssessment = null;

    // Validate work item data before calling Agent
    if (!this.itemData?.fields || Object.keys(this.itemData.fields).length === 0) {
      this.qualityAssessmentError = 'Cannot assess quality: work item has no fields';
      this.qualityAssessmentLoading = false;
      return;
    }

    if (!this.itemData.fields['System.Title']) {
      this.qualityAssessmentError = 'Cannot assess quality: work item missing essential data';
      this.qualityAssessmentLoading = false;
      return;
    }

    try {
      console.log('Auto-assessing PBI quality...');
      const result = await this.apiService.analyzeWithClaude(this.itemData, 'pbiQualityAssessment');

      if (result.success) {
        // Parse JSON response
        try {
          const jsonMatch = result.data.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            this.qualityAssessment = JSON.parse(jsonMatch[0]);
            console.log('Quality assessment:', this.qualityAssessment);
          } else {
            this.qualityAssessmentError = 'Failed to parse quality assessment response';
          }
        } catch (parseError) {
          console.error('Failed to parse quality assessment JSON:', parseError);
          console.log('Raw response:', result.data);
          this.qualityAssessmentError = 'Failed to parse quality assessment';
        }
      } else {
        this.qualityAssessmentError = result.error || 'Quality assessment failed';
      }
    } catch (error: any) {
      console.error('Error assessing PBI quality:', error);
      // For HTTP errors, extract the backend error message
      this.qualityAssessmentError = error.error?.error || error.message || 'Failed to assess PBI quality';
    } finally {
      this.qualityAssessmentLoading = false;
    }
  }

  buildAdditionalContext(): string {
    if (!this.qualityAssessment?.missing_keywords) return '';

    // Use consolidated response if available
    if (this.consolidatedResponse && this.consolidatedResponse.trim()) {
      const keywords = this.qualityAssessment.missing_keywords.join(', ');
      return `Additional context for missing information (${keywords}):\n\n${this.consolidatedResponse}`;
    }

    return '';
  }

  getConsolidatedPrompt(): string {
    if (!this.qualityAssessment?.improvement_points || this.qualityAssessment.improvement_points.length === 0) {
      return '';
    }

    // Create a concise prompt using only the critical improvement points (3-5 items)
    // Format as numbered list
    const prompts = this.qualityAssessment.improvement_points
      .map((point, index) => `${index + 1}. ${point.prompt}`)
      .join('\n');

    return prompts;
  }

  async generateTestCases(withFeedback: boolean = false, generateAll: boolean = false) {
    if (!this.itemData) {
      this.error = 'Please fetch a PBI first';
      return;
    }

    // Validate work item data before calling Agent
    if (!this.itemData?.fields || Object.keys(this.itemData.fields).length === 0) {
      this.error = 'Work item data is incomplete. Please fetch a valid PBI with proper permissions.';
      return;
    }

    if (!this.itemData.fields['System.Title']) {
      this.error = 'Work item is missing essential data required for test case generation.';
      return;
    }

    if (withFeedback && !this.userFeedback.trim()) {
      this.error = 'Please provide feedback before regenerating';
      return;
    }

    // Log generation mode
    if (generateAll) {
      console.log('📋 Generating ALL test cases (comprehensive mode)');
    } else {
      console.log('📋 Generating Happy Path + Top 5 Critical tests (focused mode)');
    }

    this.loading = true;
    this.error = '';
    this.startGeneratingAnimation();
    this.progressMessage = withFeedback ? 'Regenerating with feedback' : 'Starting tests generation';

    // Get the previous test cases if providing feedback
    const previousTestCases = withFeedback && this.analysisResults.length > 0
      ? this.analysisResults[this.analysisResults.length - 1].content
      : undefined;

    // Build additional context from quality assessment improvement points
    const additionalContext = this.buildAdditionalContext();

    if (!withFeedback && !generateAll) {
      // Only clear results if this is a new generation (not feedback, not generate-all)
      this.analysisResults = [];
      this.userFeedback = '';
    }

    try {
      const result = await this.apiService.analyzeWithClaude(
        this.itemData,
        'testCases',
        withFeedback ? this.userFeedback : undefined,
        previousTestCases,
        additionalContext || undefined,
        generateAll,
        (message: string) => {
          // Update progress message from server
          this.progressMessage = message;
        }
      );

      if (result.success) {
        const htmlContent = marked.parse(result.data);

        let qualityScoreHtml: SafeHtml | undefined = undefined;
        if (result.qualityScore) {
          qualityScoreHtml = this.sanitizer.sanitize(1, marked.parse(result.qualityScore)) || '';
        }

        // Extract preamble, main test cases, and additional tests
        const preambleContent = this.extractPreamble(result.data);
        const mainTestCases = this.extractMainTestCases(result.data);

        this.analysisResults.push({
          type: 'testCases',
          content: result.data,
          htmlContent: this.sanitizer.sanitize(1, htmlContent) || '',
          preambleHtml: preambleContent ? this.sanitizer.sanitize(1, marked.parse(preambleContent)) || undefined : undefined,
          mainTestCasesHtml: this.sanitizer.sanitize(1, marked.parse(mainTestCases)) || '',
          timestamp: new Date(),
          qualityScore: result.qualityScore,
          qualityScoreHtml: qualityScoreHtml,
          iterations: result.iterations,
          isFocusedGeneration: !generateAll
        });

        // Clear feedback and error after successful regeneration
        if (withFeedback) {
          this.userFeedback = '';
        }
        this.error = ''; // Clear any previous errors on success
      } else {
        this.error = result.error || 'Failed to generate test cases';
      }
    } catch (error: any) {
      // For HTTP errors, extract the backend error message
      const backendError = error.error?.error || error.message || 'An unexpected error occurred';
      this.error = `Error generating test cases: ${backendError}`;
      console.error('Test case generation error:', error);
    } finally {
      this.loading = false;
      this.stopGeneratingAnimation();
    }
  }

  startGeneratingAnimation() {
    this.generatingDots = '';
    this.generatingInterval = setInterval(() => {
      if (this.generatingDots === '...') {
        this.generatingDots = '';
      } else {
        this.generatingDots += '.';
      }
    }, 500); // Update every 500ms
  }

  stopGeneratingAnimation() {
    if (this.generatingInterval) {
      clearInterval(this.generatingInterval);
      this.generatingInterval = null;
    }
    this.generatingDots = '';
    this.progressMessage = '';
  }

  copyToClipboard(content: string) {
    navigator.clipboard.writeText(content).then(() => {
      alert('Copied to clipboard!');
    }).catch(err => {
      console.error('Failed to copy:', err);
    });
  }

  clearResults() {
    this.analysisResults = [];
    this.itemData = null;
    this.qualityAssessment = null;
    this.qualityAssessmentLoading = false;
    this.qualityAssessmentError = '';
    this.improvementResponses = {};
    this.consolidatedResponse = '';
    this.showContextForm = false;
    this.showJustification = false;
    this.error = '';
  }

  getQualityCategoryClass(): string {
    if (!this.qualityAssessment) return '';
    const category = this.qualityAssessment.quality_category;
    return category === 'GOOD' ? 'quality-good' :
           category === 'OK' ? 'quality-ok' : 'quality-bad';
  }

  getQualityCategoryIcon(): string {
    if (!this.qualityAssessment) return '';
    const category = this.qualityAssessment.quality_category;
    return category === 'GOOD' ? '✓' :
           category === 'OK' ? '⚠' : '✗';
  }

  toggleContextForm() {
    this.showContextForm = !this.showContextForm;
  }

  toggleJustification() {
    this.showJustification = !this.showJustification;
  }

  openExportModal() {
    if (!this.analysisResults.length) {
      this.error = 'No test cases to export';
      return;
    }

    this.showExportModal = true;
  }

  closeExportModal() {
    this.showExportModal = false;
  }

  onExported(data: any) {
    this.exportSuccess = `Successfully exported ${data.testCasesCreated} test case(s) to Azure DevOps!`;

    if (data.testCasesFailed > 0) {
      this.exportSuccess += ` (${data.testCasesFailed} failed)`;
    }

    setTimeout(() => {
      this.exportSuccess = '';
    }, 8000);
  }

  // Extract content before TC-001 (test suite summary, quality assessment, analysis, etc.)
  extractPreamble(content: string): string {
    const tc001Match = content.match(/^(.*?)(?=##?\s*TC-001)/s);
    return tc001Match ? tc001Match[1].trim() : '';
  }

  // Extract main test cases (TC-001 to TC-006 or all if generateAll was true)
  extractMainTestCases(content: string): string {
    const tc001Start = content.search(/##?\s*TC-001/);
    if (tc001Start === -1) {
      return content; // No TC-001 found, return all content
    }
    return content.substring(tc001Start);
  }

  toggleAdditionalInfo() {
    this.showAdditionalInfo = !this.showAdditionalInfo;
  }

  toggleAdditionalTests() {
    this.showAdditionalTests = !this.showAdditionalTests;
  }

  ngOnDestroy() {
    // Clean up intervals to prevent memory leaks
    this.stopGeneratingAnimation();
  }
}
