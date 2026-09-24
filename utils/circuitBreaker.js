// Circuit breaker for managing fallback between primary and secondary RPC providers
import { sendTelegramAlert } from './telegramUtils.js';
import { redactUrl } from './redactUrl.js';

class CircuitBreaker {
  constructor(options = {}) {
    this.primaryUrl = options.primaryUrl;
    this.fallbackUrl = options.fallbackUrl;
    this.name = options.name || 'Circuit breaker'; // Name for alerts
    
    // Check if fallback is properly configured
    if (!this.fallbackUrl || this.fallbackUrl.trim() === '') {
      console.warn('⚠️  No fallback URL configured - circuit breaker will only use primary URL');
      this.hasFallback = false;
    } else {
      this.hasFallback = true;
    }
    
    // Circuit breaker configuration
    this.failureThreshold = options.failureThreshold || 2; // Switch to fallback after 2 consecutive failures
    this.resetTimeout = options.resetTimeout || 60000; // Try primary again after 60 seconds
    this.requestTimeout = options.requestTimeout || 10000; // 10 second timeout for requests
    
    // State tracking
    this.consecutiveFailures = 0;
    this.lastFailureTime = 0;
    this.state = 'CLOSED'; // CLOSED, OPEN, HALF_OPEN
    this.isUsingFallback = false;
    this.previousState = 'CLOSED'; // Track state changes for alerts
    
    console.log(`Circuit breaker initialized - Primary: ${this.primaryUrl}, Fallback: ${redactUrl(this.fallbackUrl)}`);
  }

  // Send alert when circuit opens
  sendOpenAlert() {
    try {
      const message = `------------------------------------------\n🔴 ALERT: Pre-Proxy ${this.name} circuit breaker is open. Using fallback url\nFallback URL: ${redactUrl(this.fallbackUrl)}`;
      sendTelegramAlert(message, 'CIRCUIT_OPEN');
    } catch (error) {
      console.error('❌ Failed to send circuit open alert:', error.message);
      // Don't throw - just log the error
    }
  }

  // Send alert when circuit closes
  sendCloseAlert() {
    try {
      const message = `------------------------------------------\n🟢 RECOVERY: Pre-Proxy ${this.name} circuit breaker is closed. Using main url\n\nPrimary URL: ${this.primaryUrl}\nRecovery time: ${new Date().toISOString()}`;
      sendTelegramAlert(message, 'CIRCUIT_CLOSED');
    } catch (error) {
      console.error('❌ Failed to send circuit close alert:', error.message);
      // Don't throw - just log the error
    }
  }

  // Get the current URL to use based on circuit breaker state
  getCurrentUrl() {
    const now = Date.now();
    
    switch (this.state) {
      case 'CLOSED':
        // Normal operation - use primary
        this.isUsingFallback = false;
        return this.primaryUrl;
        
      case 'OPEN':
        // Circuit is open - check if we should try primary again
        if (now - this.lastFailureTime >= this.resetTimeout) {
          this.state = 'HALF_OPEN';
          this.isUsingFallback = false;
          console.log('🔄 Circuit breaker moving to HALF_OPEN - trying primary URL again');
          return this.primaryUrl;
        }
        // If no fallback configured, force back to primary
        if (!this.hasFallback) {
          console.log('⚠️  No fallback available - forcing back to primary URL');
          this.isUsingFallback = false;
          return this.primaryUrl;
        }
        // Still in fallback mode
        this.isUsingFallback = true;
        return this.fallbackUrl;
        
      case 'HALF_OPEN':
        // Testing if primary is back online
        this.isUsingFallback = false;
        return this.primaryUrl;
        
      default:
        this.isUsingFallback = false;
        return this.primaryUrl;
    }
  }

  // Call this when a request succeeds
  onSuccess() {
    if (this.state === 'HALF_OPEN') {
      console.log('✅ Circuit breaker: Primary URL recovered - closing circuit');
      this.state = 'CLOSED';
      // Send recovery alert when transitioning from HALF_OPEN to CLOSED
      if (this.previousState !== 'CLOSED') {
        this.sendCloseAlert();
      }
    }
    this.consecutiveFailures = 0;
    this.previousState = this.state;
  }

  // Call this when a request fails
  onFailure(error) {
    this.consecutiveFailures++;
    this.lastFailureTime = Date.now();
    
    console.log(`❌ Circuit breaker: Failure ${this.consecutiveFailures}/${this.failureThreshold} - ${error.message}`);
    
    if (this.state === 'HALF_OPEN') {
      // Primary still not working, go back to open
      this.state = 'OPEN';
      this.isUsingFallback = true;
      console.log('🚨 Circuit breaker: Primary still failing - reopening circuit');
      // Send alert when transitioning from HALF_OPEN to OPEN
      if (this.previousState !== 'OPEN') {
        this.sendOpenAlert();
      }
    } else if (this.consecutiveFailures >= this.failureThreshold && this.state === 'CLOSED') {
      if (!this.hasFallback) {
        console.log(`🚨 Circuit breaker: Would open but no fallback configured - staying with primary URL after ${this.consecutiveFailures} failures`);
        // Don't change state if no fallback available
      } else {
        // Threshold reached, open the circuit
        this.state = 'OPEN';
        this.isUsingFallback = true;
        console.log(`🚨 Circuit breaker: OPENED - switching to fallback URL after ${this.consecutiveFailures} failures`);
        // Send alert when transitioning from CLOSED to OPEN
        this.sendOpenAlert();
      }
    }
    
    this.previousState = this.state;
  }

  // Check if we're currently using the fallback
  isCurrentlyUsingFallback() {
    return this.isUsingFallback;
  }

  // Get status for monitoring
  getStatus() {
    return {
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      isUsingFallback: this.isUsingFallback,
      currentTarget: this.getCurrentUrl() === this.primaryUrl ? 'primary' : 'fallback',
      lastFailureTime: this.lastFailureTime
    };
  }
}

export { CircuitBreaker }; 