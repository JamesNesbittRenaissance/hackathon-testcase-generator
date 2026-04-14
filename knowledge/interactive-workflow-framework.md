# AI Test Case Generation Framework
## Interactive Workflow Guide for PBI Analysis

---

## Overview

This framework defines an **interactive, conversational process** for AI-assisted test case generation based on Product Backlog Items (PBIs). The AI engine guides users through analysis, gap identification, test type selection, risk assessment, and test case creation, ultimately outputting to Azure DevOps Test Plans.

**Key Principles:**
- **Interactive & Conversational**: AI suggests, user confirms
- **Transparent**: AI explains its reasoning at each step
- **Flexible**: User can override AI suggestions
- **Quality-Focused**: Comprehensive coverage without overkill
- **DevOps-Integrated**: Output goes directly to Azure DevOps Test Plans

---

## Workflow Steps

### Step 1: Analyze PBI and Identify Work Item Type

**AI Actions:**
1. Parse the PBI information received from Azure DevOps
2. Identify the work item type (User Story, Bug, Task, Product Backlog Item, Spike, etc.)
3. Extract key information:
   - Title and description
   - Acceptance criteria
   - Assigned components/areas
   - Priority and business value
   - Related work items
   - Custom fields (complexity, affected systems, etc.)

**AI Output to User:**
```
Analysis Complete:
- Work Item Type: [User Story | Bug | Task | PBI | Spike]
- Title: [PBI Title]
- Priority: [High | Medium | Low]
- Complexity: [High | Medium | Low]
- Affected Components: [List of components]
- Related Work Items: [Parent, children, related items]
```

**Example:**
```
Analysis Complete:
- Work Item Type: User Story
- Title: Implement user authentication with OAuth 2.0
- Priority: High
- Complexity: Medium
- Affected Components: Authentication Service, User Management API, Frontend Login Module
- Related Work Items: Parent Epic #12345, Related Bug #67890
```

---

### Step 2: Identify PBI Gaps and Alert User

**AI Actions:**
1. Review PBI for completeness and quality
2. Identify missing or unclear information
3. Flag potential issues or ambiguities
4. Suggest improvements

**Gap Categories to Check:**

#### Critical Gaps (Must Address)
- Missing or vague acceptance criteria
- No description or insufficient detail
- Undefined success criteria
- Missing affected components/systems

#### Important Gaps (Should Address)
- No defined user personas or roles
- Missing non-functional requirements (performance, security)
- Unclear edge cases or error handling
- No mention of data requirements

#### Nice-to-Have Information
- Missing UI/UX designs or mockups
- No performance benchmarks specified
- Missing API contracts or specifications
- No test data availability information

**AI Output to User:**
```
PBI Quality Assessment:

⚠️ CRITICAL GAPS FOUND:
- Acceptance Criterion #3 is vague: "System should handle errors properly"
  Suggestion: Specify what errors, how they should be handled, and expected user experience

- No specification for password complexity requirements
  Suggestion: Define minimum length, character requirements, forbidden patterns

✓ Important Information Present:
- Clear user workflow described
- Integration points identified
- Security requirements mentioned

💡 RECOMMENDATIONS:
- Consider adding: Session timeout duration
- Consider adding: Multi-factor authentication scope
- Consider adding: Browser compatibility requirements

Would you like to:
1. Update the PBI with these improvements before proceeding
2. Continue with current PBI state and note gaps as assumptions
3. Discuss specific gaps in detail
```

**User Decision Point:**
User chooses to either:
- Update the PBI (AI pauses, user makes changes, then restarts process)
- Continue as-is (AI notes gaps and makes reasonable assumptions, documenting them)

---

### Step 3: Suggest Test Types and Get User Confirmation

**AI Actions:**
1. Based on work item type and content, suggest applicable test types
2. Explain why each test type is relevant
3. Provide recommendations on priority
4. Allow user to confirm, skip, or adjust

**Test Type Categories:**

#### Core Test Types (Always Consider)
- **Functional Testing (Positive Paths)**: Verify features work as intended
- **Functional Testing (Negative Paths)**: Verify error handling and invalid inputs
- **Edge Cases**: Boundary conditions, unusual scenarios
- **Regression Testing**: Ensure existing functionality isn't broken (risk-based)

#### Additional Test Types (Context-Dependent)
- **Integration Testing**: When multiple systems/components interact
- **Performance Testing**: When speed, load, or scalability matters
- **Security Testing**: When handling sensitive data, authentication, or authorization
- **Accessibility Testing**: For user-facing interfaces (WCAG compliance)
- **Responsiveness Testing**: For web applications across devices/resolutions
- **UI Testing**: Visual validation based on designs/mockups
- **UX Testing**: User experience and workflow validation
- **Data Testing**: When seeding, migrating, or consuming external data
- **Browser/Platform Compatibility**: For web applications
- **API Contract Testing**: For API changes or new endpoints

**AI Output to User:**
```
Recommended Test Types for This PBI:

✅ HIGHLY RECOMMENDED:
1. Functional Testing (Positive Paths) - Priority: CRITICAL
   Why: Core authentication workflow must work correctly
   Coverage: Login, logout, password reset, session management

2. Functional Testing (Negative Paths) - Priority: HIGH
   Why: Must handle invalid credentials, locked accounts, expired sessions gracefully
   Coverage: Invalid passwords, non-existent users, session timeout scenarios

3. Security Testing - Priority: CRITICAL
   Why: Authentication is a high-security area
   Coverage: SQL injection, XSS, CSRF, password storage, session hijacking

4. Regression Testing - Priority: HIGH
   Why: Changes to authentication may impact existing user workflows
   Coverage: [Will be determined in risk analysis step]

5. Edge Cases - Priority: MEDIUM
   Why: Unusual scenarios may cause unexpected failures
   Coverage: Extremely long passwords, special characters, concurrent login attempts

✅ RECOMMENDED:
6. Integration Testing - Priority: HIGH
   Why: Authentication service integrates with user database and email service
   Coverage: Database connectivity, email service for password reset

7. Responsiveness Testing - Priority: MEDIUM
   Why: Login page must work on mobile devices
   Coverage: Mobile (320px-768px), Tablet (768px-1024px), Desktop (1024px+)

8. UI Testing - Priority: MEDIUM
   Why: Login UI must match design specifications
   Coverage: Layout, button styles, error message display, loading states

9. Accessibility Testing - Priority: MEDIUM
   Why: Login must be accessible to users with disabilities
   Coverage: Keyboard navigation, screen reader compatibility, WCAG 2.1 AA compliance

⚪ OPTIONAL (Consider if applicable):
10. Performance Testing - Priority: LOW
    Why: Login should be fast, but not expected to have high load
    Coverage: Response time under normal load, concurrent user handling

11. Data Testing - Priority: LOW
    Why: Existing user data must remain valid after authentication changes
    Coverage: Data migration, existing user account validation

Which test types would you like to include?
- Type "all" to include all recommended
- Type numbers to select specific types (e.g., "1,2,3,6,7")
- Type "critical" for only critical/high priority types
- Request changes or ask questions about any type
```

**User Decision Point:**
User selects which test types to include in the test case generation.

---

### Step 4: Perform Risk Analysis for Regression Testing

**AI Actions:**
1. Analyze the PBI changes and their potential impact
2. Identify areas of the system that could be affected
3. Assess risk using **Probability × Severity** matrix
4. Suggest regression test areas with justification

**Risk Assessment Criteria:**

#### Probability Levels
- **High**: Change directly modifies this area OR tightly coupled component
- **Medium**: Indirect dependency OR shared data structures
- **Low**: Loosely coupled OR different domain

#### Severity Levels
- **Critical**: System unusable, data loss, security breach, financial impact
- **High**: Major feature broken, significant user impact, workflow blocked
- **Medium**: Minor feature affected, workaround available
- **Low**: Cosmetic issue, minimal impact

**Risk Priority = Probability × Severity**
- Critical Priority: High Probability + Critical/High Severity
- High Priority: High Probability + Medium Severity OR Medium Probability + Critical/High Severity
- Medium Priority: Medium Probability + Medium Severity OR Low Probability + Critical/High Severity
- Low Priority: All other combinations

**AI Output to User:**
```
Regression Risk Analysis:

Based on the authentication system changes, the following areas may be affected:

🔴 CRITICAL RISK - Must Test:
1. User Profile Management (Risk Score: High × Critical = CRITICAL)
   - Probability: HIGH - Authentication changes may affect user session data
   - Severity: CRITICAL - Users unable to access their profiles
   - Impact: All logged-in users cannot view/edit profiles
   - Suggested Tests: Profile page load, profile editing, profile viewing by other users

2. Authorization & Permissions (Risk Score: High × Critical = CRITICAL)
   - Probability: HIGH - Authentication layer changed, auth token format may differ
   - Severity: CRITICAL - Users may get unauthorized access or be blocked from authorized resources
   - Impact: Security breach or complete feature lockout
   - Suggested Tests: Admin access controls, role-based permissions, resource authorization

🟠 HIGH RISK - Strongly Recommend Testing:
3. Shopping Cart & Checkout (Risk Score: Medium × High = HIGH)
   - Probability: MEDIUM - Requires authenticated session
   - Severity: HIGH - Revenue impact if checkout fails
   - Impact: Users cannot complete purchases
   - Suggested Tests: Add to cart while logged in, checkout flow, saved cart persistence

4. User Notifications (Risk Score: High × Medium = HIGH)
   - Probability: HIGH - Email service integration shared with password reset
   - Severity: MEDIUM - Notifications may fail but core features work
   - Impact: Users don't receive important alerts
   - Suggested Tests: Email notifications, in-app notifications, notification preferences

🟡 MEDIUM RISK - Consider Testing:
5. Account Settings (Risk Score: Medium × Medium = MEDIUM)
   - Probability: MEDIUM - Settings page requires authentication
   - Severity: MEDIUM - Workaround: contact support
   - Impact: Users cannot change preferences
   - Suggested Tests: Email preferences, notification settings, privacy settings

⚪ LOW RISK - Optional Testing:
6. Public Marketing Pages (Risk Score: Low × Low = LOW)
   - Probability: LOW - No authentication required
   - Severity: LOW - Marketing content unaffected
   - Impact: Minimal
   - Suggested Tests: Optional smoke test

---
SUMMARY:
- Critical Risk Areas: 2
- High Risk Areas: 2
- Medium Risk Areas: 1
- Low Risk Areas: 1

Which regression areas would you like to include?
- Type "critical" for only critical risk areas
- Type "critical+high" for critical and high risk areas (recommended)
- Type "all" for comprehensive regression testing
- Select specific numbers (e.g., "1,2,3")
- Request more details on any area
```

**User Decision Point:**
User confirms which regression areas to test.

---

### Step 5: User Confirms Test Scope

**AI Actions:**
1. Summarize all user selections
2. Provide estimated test case count
3. Allow final adjustments before generation

**AI Output to User:**
```
Test Scope Summary:

📋 SELECTED TEST TYPES:
✓ Functional Testing (Positive Paths) - ~12 test cases
✓ Functional Testing (Negative Paths) - ~8 test cases
✓ Security Testing - ~15 test cases
✓ Integration Testing - ~5 test cases
✓ Edge Cases - ~6 test cases
✓ Responsiveness Testing - ~4 test cases
✓ UI Testing - ~5 test cases
✓ Accessibility Testing - ~6 test cases

📋 REGRESSION TEST AREAS:
✓ User Profile Management - ~4 test cases
✓ Authorization & Permissions - ~6 test cases
✓ Shopping Cart & Checkout - ~5 test cases

📊 ESTIMATED TOTALS:
- Total Test Cases: ~76
- Critical Priority: ~15
- High Priority: ~32
- Medium Priority: ~24
- Low Priority: ~5

⏱️ Estimated Generation Time: 2-3 minutes

Ready to generate test cases?
- Type "yes" to proceed
- Type "adjust" to modify selections
- Type "details" for breakdown by category
```

**User Decision Point:**
User confirms to proceed or makes adjustments.

---

### Step 6: Generate Test Cases

**AI Actions:**
1. Generate comprehensive test cases for each selected type
2. Follow quality standards (clear steps, specific expected results, traceability)
3. Include test data requirements
4. Map to acceptance criteria
5. Assign priorities

**Test Case Structure:**
Each test case includes:
- **Test Case ID**: Unique identifier (TC-001, TC-002, etc.)
- **Title**: Clear, descriptive name
- **Type**: Functional, Security, Integration, etc.
- **Priority**: Critical, High, Medium, Low
- **Acceptance Criteria Link**: Maps to specific AC
- **Preconditions**: Required setup or state
- **Test Data**: Specific data needed for execution
- **Test Steps**: Numbered, actionable steps
- **Expected Result**: Clear, measurable outcome
- **Pass/Fail Criteria**: Objective success criteria

**AI Output to User:**
```
Generating test cases...

✓ Functional Tests (Positive Paths): 12 test cases generated
✓ Functional Tests (Negative Paths): 8 test cases generated
✓ Security Tests: 15 test cases generated
✓ Integration Tests: 5 test cases generated
✓ Edge Cases: 6 test cases generated
✓ Responsiveness Tests: 4 test cases generated
✓ UI Tests: 5 test cases generated
✓ Accessibility Tests: 6 test cases generated
✓ Regression Tests: 15 test cases generated

Total: 76 test cases generated

Preview available. Proceed to automation analysis?
```

---

### Step 7: Suggest Automation Candidates

**AI Actions:**
1. Analyze each test case for automation feasibility
2. Categorize as: High, Medium, Low, or Not Recommended for automation
3. Provide reasoning for each recommendation
4. Suggest automation tools/frameworks

**Automation Feasibility Criteria:**

#### High Priority for Automation
- Repetitive tests executed frequently
- Regression tests
- Tests with clear, deterministic outcomes
- Tests that require multiple data sets
- Performance/load tests
- Security tests (injection attempts, etc.)
- API/integration tests

#### Medium Priority for Automation
- UI tests with stable elements
- Tests requiring moderate setup
- Cross-browser/device tests
- Data validation tests

#### Low Priority for Automation
- Exploratory testing scenarios
- Tests requiring subjective judgment
- Tests with frequently changing UI
- Visual design validation (without visual testing tools)

#### Not Recommended for Automation
- Usability tests requiring human judgment
- Ad-hoc exploratory testing
- Tests where automation cost > value

**AI Output to User:**
```
Automation Recommendations:

🤖 HIGH PRIORITY FOR AUTOMATION (32 test cases):

Functional Tests - Positive Paths (10/12 test cases)
- TC-001: User logs in with valid credentials ✓
  Reason: Repetitive, deterministic, core workflow
  Tool: Selenium/Playwright/Cypress
- TC-002: User logs out successfully ✓
  Reason: Simple, repeatable, regression candidate
  Tool: Selenium/Playwright/Cypress
[...continue list...]

Security Tests (15/15 test cases)
- TC-100: SQL Injection attempt in login form ✓
  Reason: Critical security test, should run on every build
  Tool: OWASP ZAP, Burp Suite, or custom scripts
- TC-101: XSS attempt in login form ✓
  Reason: Critical security test, should run on every build
  Tool: OWASP ZAP, Burp Suite
[...continue list...]

Integration Tests (5/5 test cases)
- TC-020: Authentication service integrates with database ✓
  Reason: API test, deterministic, regression candidate
  Tool: Postman, RestAssured, Pytest
[...continue list...]

🟡 MEDIUM PRIORITY FOR AUTOMATION (22 test cases):

UI Tests (3/5 test cases)
- TC-070: Login button displays correctly ⚠️
  Reason: Visual validation possible with screenshot comparison
  Tool: Percy, Applitools, or custom screenshot comparison
  Note: Requires maintenance if UI changes frequently
[...continue list...]

Responsiveness Tests (4/4 test cases)
- TC-055: Login page responsive on mobile (320px) ⚠️
  Reason: Can be automated with viewport testing
  Tool: Selenium with viewport settings, BrowserStack
[...continue list...]

⚪ LOW PRIORITY / MANUAL TESTING (22 test cases):

Accessibility Tests (4/6 automated, 2 manual)
- TC-090: Screen reader announces login form fields ⚠️
  Reason: Can use aXe or similar tools, but manual validation recommended
  Tool: aXe DevTools, WAVE, manual testing
- TC-091: User experience with keyboard-only navigation ❌
  Reason: Requires human judgment on usability
  Tool: Manual testing
[...continue list...]

UX/Usability Tests (Manual only)
- TC-095: Error messages are clear and helpful ❌
  Reason: Subjective evaluation required
  Tool: Manual testing with real users

---
AUTOMATION SUMMARY:
- High Priority: 32 test cases (~42% of total)
- Medium Priority: 22 test cases (~29% of total)
- Low Priority/Manual: 22 test cases (~29% of total)

Estimated ROI: High - Core functional and security tests will save significant manual testing time

Recommended Tools:
- UI Automation: Playwright or Cypress (modern, reliable)
- API Testing: RestAssured or Pytest
- Security Testing: OWASP ZAP (open source)
- Accessibility: aXe DevTools
- Visual Testing: Percy or Applitools (if budget allows)

Would you like to:
1. Proceed with these automation recommendations
2. Adjust automation priorities
3. Get more details on specific tests
```

**User Decision Point:**
User reviews and confirms automation recommendations.

---

### Step 8: Define and Create Test Data

**AI Actions:**
1. Identify test data requirements across all test cases
2. Suggest test data sets (valid, invalid, edge cases, security payloads)
3. Provide data generation strategies
4. Offer to create test data templates or scripts

**Test Data Categories:**

#### Valid Test Data
- Typical user inputs that should succeed
- Represent common usage patterns
- Cover different user roles/personas

#### Invalid Test Data
- Malformed inputs
- Missing required fields
- Wrong data types
- Out-of-range values

#### Edge Case Test Data
- Boundary values (min/max)
- Special characters
- Unicode/internationalization
- Extremely long inputs

#### Security Test Data
- SQL injection payloads
- XSS payloads
- CSRF tokens
- Authentication bypass attempts

**AI Output to User:**
```
Test Data Requirements:

📊 USER ACCOUNTS (Authentication Tests):

Valid Users:
| Username | Password | Role | Status | Purpose |
|----------|----------|------|--------|---------|
| john.doe@example.com | SecurePass123! | User | Active | Standard login tests |
| jane.admin@example.com | AdminPass456! | Admin | Active | Admin workflow tests |
| sarah.user@example.com | UserPass789! | User | Active | Secondary user for concurrent tests |

Invalid/Edge Case Users:
| Username | Password | Status | Purpose |
|----------|----------|--------|---------|
| locked.user@example.com | AnyPassword | Locked | Test locked account handling |
| expired.user@example.com | ExpiredPass | Active (expired session) | Session timeout tests |
| new.user@example.com | N/A | Not registered | New user registration |
| very.long.email.address.that.exceeds.normal.length@subdomain.example.com | Pass123! | Active | Edge case: max length email |

Security Test Data:
| Username | Password | Purpose |
|----------|----------|---------|
| admin' OR '1'='1 | ' OR '1'='1 | SQL injection test |
| <script>alert('xss')</script> | test123 | XSS test |
| admin@example.com | [Empty] | Missing password test |
| [Empty] | password123 | Missing username test |

---

📊 SESSION DATA:

| Session Type | Duration | Purpose |
|--------------|----------|---------|
| Valid session | 30 minutes | Normal authenticated state |
| Expired session | >30 minutes old | Session timeout test |
| Invalid session token | N/A | Tampered token test |
| Concurrent sessions | Multiple active | Concurrent login test |

---

📊 PASSWORD TEST DATA:

Valid Passwords (meeting complexity requirements):
- SecurePass123!
- MyP@ssw0rd2024
- C0mpl3x!ty_Test

Invalid Passwords:
- short (too short)
- password (too common)
- 12345678 (all numbers)
- abcdefgh (no numbers or special chars)
- PASSWORD123! (no lowercase)

Edge Case Passwords:
- aA1!aA1!aA1!aA1!aA1!aA1!aA1!aA1! (maximum length: 32 chars)
- P@ssw0rd123 (exactly minimum requirements)
- 密码P@ssw0rd123 (Unicode characters)

---

📊 UI TEST DATA (Responsiveness):

| Device Category | Resolution | Orientation | Test Scenarios |
|-----------------|------------|-------------|----------------|
| Mobile | 320x568 | Portrait | iPhone SE |
| Mobile | 375x667 | Portrait | iPhone 8 |
| Mobile | 414x896 | Portrait | iPhone 11 Pro |
| Tablet | 768x1024 | Portrait | iPad |
| Tablet | 1024x768 | Landscape | iPad Landscape |
| Desktop | 1366x768 | Landscape | Standard laptop |
| Desktop | 1920x1080 | Landscape | Full HD desktop |

---

DATA GENERATION OPTIONS:

Option 1: Manual Test Data
- I can create a test data spreadsheet/CSV with all values
- You can import into your test environment

Option 2: Test Data Scripts
- I can generate SQL scripts to seed your test database
- I can create JSON fixtures for API testing
- I can generate test data generation scripts (Python/JavaScript)

Option 3: API-Based Test Data
- Use existing API endpoints to create test accounts
- I can provide API request examples

Which option would you prefer?
- Type "1" for manual test data (spreadsheet/CSV)
- Type "2" for automated scripts
- Type "3" for API-based approach
- Type "all" for complete test data package
- Request specific data formats or modifications
```

**User Decision Point:**
User selects test data approach and confirms data requirements.

---

### Step 9: Output to Azure DevOps Test Plans

**AI Actions:**
1. Format test cases for Azure DevOps Test Plans import
2. Organize into test suites based on test types
3. Link test cases to PBI/work items
4. Set priorities and assign to test plans
5. Include test data references

**Azure DevOps Output Structure:**

Test Plans Hierarchy:
```
Test Plan: [PBI Title] - Test Cases
├── Test Suite: Functional Tests (Positive Paths)
│   ├── TC-001: User logs in with valid credentials
│   ├── TC-002: User logs out successfully
│   └── ...
├── Test Suite: Functional Tests (Negative Paths)
│   ├── TC-015: Login with invalid password
│   ├── TC-016: Login with non-existent user
│   └── ...
├── Test Suite: Security Tests
│   ├── TC-100: SQL Injection attempt
│   ├── TC-101: XSS attempt
│   └── ...
├── Test Suite: Integration Tests
│   └── ...
├── Test Suite: Regression Tests
│   ├── Sub-Suite: User Profile Management
│   ├── Sub-Suite: Authorization & Permissions
│   └── ...
└── Test Suite: UI & Responsiveness Tests
    └── ...
```

**AI Output to User:**
```
Azure DevOps Test Plans - Export Ready

✅ Test Cases Organized:
- Total Test Cases: 76
- Test Suites: 8 main suites, 3 sub-suites
- Linked to PBI: #95962
- Test Plan: "User Authentication - OAuth 2.0 Implementation"

✅ Test Case Fields Populated:
- Title ✓
- Steps ✓
- Expected Results ✓
- Priority ✓
- Assigned To: [Will be set in Azure DevOps]
- Area Path: Authentication/User Management
- Iteration: [Current sprint]

✅ Additional Information:
- Acceptance Criteria Mapping: Included in test case descriptions
- Test Data References: Linked to test data suite
- Automation Status: Tagged with "AutomationCandidate" where applicable

EXPORT OPTIONS:

Option 1: Excel Import Template (Recommended)
- Download formatted Excel file
- Import directly into Azure DevOps Test Plans
- One-click import with all relationships preserved

Option 2: API Import (Automated)
- Direct integration with Azure DevOps API
- Test cases created automatically
- Requires Azure DevOps PAT token

Option 3: Manual Creation Guide
- Step-by-step instructions
- Copy-paste ready format
- Useful for small test sets

Which export method would you prefer?
- Type "1" for Excel template (recommended for large test sets)
- Type "2" for API automation (requires configuration)
- Type "3" for manual creation guide

I can also:
- Preview test cases before export
- Generate test execution reports template
- Create test case associations/links
- Set up test configurations (browsers, environments)
```

**User Decision Point:**
User selects export method and confirms final output.

---

## Test Case Quality Standards

Regardless of test type, all generated test cases must meet these quality criteria:

### Clarity
- Titles are descriptive and unique
- Steps are numbered and actionable
- Expected results are specific and measurable
- No ambiguous language ("should work", "properly", etc.)

### Completeness
- All fields populated (no TBD or placeholder values)
- Prerequisites clearly stated
- Test data specified
- Pass/fail criteria defined

### Traceability
- Linked to acceptance criteria
- Linked to PBI/work item
- Related test cases cross-referenced

### Testability
- Can be executed by anyone with the prerequisites
- Results are objectively verifiable
- Test cases are independent (where possible)
- Test cases are repeatable

### Maintainability
- Structured format for easy updates
- Automation tags included where applicable
- Clear notes on risks, dependencies, limitations

---

## Conversation Guidelines for AI

### Tone and Communication Style
- **Professional but conversational**: Explain reasoning clearly
- **Transparent**: Always explain "why" behind suggestions
- **Collaborative**: Frame as suggestions, not mandates
- **Flexible**: User can override any recommendation
- **Concise**: Avoid overwhelming with too much information at once

### When to Ask for Clarification
- Ambiguous acceptance criteria
- Missing critical information
- Conflicting requirements
- Unclear scope or boundaries

### When to Make Assumptions
- Minor implementation details
- Standard industry practices (with note to user)
- Common patterns unless otherwise specified
- ALWAYS document assumptions made

### Error Handling
- If PBI is severely lacking, pause and recommend improvements
- If user requests something unreasonable, explain constraints politely
- If unable to complete a step, provide alternative approaches

---

## Version History

| Version | Date | Changes | Author |
|---------|------|---------|--------|
| 2.0 | 2026-04-13 | Rewritten as interactive workflow guide | AI Assistant |
| 1.0 | 2026-04-13 | Initial template-based framework | AI Assistant |

---

## Quick Reference: Test Type Decision Matrix

Use this matrix to quickly determine which test types to recommend:

| Work Item Type | Core Tests | Additional Tests (if applicable) |
|----------------|------------|----------------------------------|
| **User Story** | Functional (pos/neg), Edge Cases, Regression | UI, UX, Accessibility, Responsiveness |
| **Bug Fix** | Functional (neg), Regression | Related feature tests |
| **New Feature** | Functional (pos/neg), Edge Cases, Integration | Performance, Security, UI, Accessibility |
| **API Change** | Functional, Integration, Regression | Performance, Security, Contract Testing |
| **UI Change** | UI, Responsiveness, Accessibility | Functional, Visual Regression |
| **Security Feature** | Security, Functional | Penetration Testing, Compliance |
| **Performance Improvement** | Performance, Functional | Load, Stress, Scalability |
| **Data Migration** | Data Testing, Functional | Integration, Regression |
| **Infrastructure** | Integration, Performance | Availability, Disaster Recovery |

---

**End of Framework**
