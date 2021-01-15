/**
 * A class that manages flight plan lateral guidance.
 */
class LNavDirector {
  /**
   * Creates an instance of the LNavDirector.
   * @param {FlightPlanManager} fpm The FlightPlanManager to use with this instance. 
   * @param {LNavDirectorOptions} options The LNAV options to use with this instance.
   */
  constructor(fpm, options) {

    /** The FlightPlanManager instance. */
    this.fpm = fpm;

    /** The current flight plan version. */
    this.currentFlightPlanVersion = 0;

    /**
     * The currently active flight plan.
     * @type {ManagedFlightPlan}
     */
    this.activeFlightPlan = undefined;

    /** The current director options. */
    this.options = options || new LNavDirectorOptions();

    /** The current flight plan sequencing mode. */
    this.sequencingMode = FlightPlanSequencing.AUTO;

    /** The current LNAV state. */
    this.state = LNavState.TRACKING;

    /** An instance of the LNAV holds director. */
    this.holdsDirector = new HoldsDirector(fpm);
  }

  /**
   * Updates the LNavDirector.
   */
  update() {
    const currentFlightPlanVersion = SimVar.GetSimVarValue('L:WT.FlightPlan.Version', 'number');
    if (this.currentFlightPlanVersion != currentFlightPlanVersion) {
      this.handleFlightPlanChanged(currentFlightPlanVersion);
    }

    if (this.activeFlightPlan) {
      const previousWaypoint = this.activeFlightPlan.getWaypoint(this.activeFlightPlan.activeWaypointIndex - 1);
      const activeWaypoint = this.activeFlightPlan.getWaypoint(this.activeFlightPlan.activeWaypointIndex);
        
      if (!this.delegateToHoldsDirector(activeWaypoint) && activeWaypoint) {
        switch (this.state) {
          case LNavState.TRACKING:
            this.handleTracking(activeWaypoint, previousWaypoint);
            break;
          case LNavState.TURN_COMPLETING:
            this.handleTurnCompleting(activeWaypoint, previousWaypoint);
            break;
        }
      }
    }
  }

  /**
   * Updates LNAV direction and tracking.
   * @param {WayPoint} activeWaypoint The current active waypoint.
   * @param {WayPoint} previousWaypoint The current previous waypoint.
   */
  handleTracking(activeWaypoint, previousWaypoint) {
    const activeLatLon = new LatLon(activeWaypoint.infos.coordinates.lat, activeWaypoint.infos.coordinates.long);
    
    const nextWaypoint = this.activeFlightPlan.getWaypoint(this.activeFlightPlan.activeWaypointIndex + 1);
    const nextLatLon = new LatLon(nextWaypoint.infos.coordinates.lat, nextWaypoint.infos.coordinates.long);

    const planeState = LNavDirector.getAircraftState();
    const planeLatLon = new LatLon(planeState.position.lat, planeState.position.long);

    const dtk = AutopilotMath.desiredTrack(previousWaypoint.infos.coordinates, activeWaypoint.infos.coordinates, planeState.position);
    const distanceToActive = planeLatLon.distanceTo(activeLatLon) / 1852;

    this.alertIfClose(planeState, distanceToActive);

    if (AutopilotMath.isAbeam(dtk, planeState.position, activeWaypoint.infos.coordinates)) {
      this.sequenceToNextWaypoint(planeState, activeWaypoint);
    }
    else {
      const nextStartTrack = activeLatLon.initialBearingTo(nextLatLon);
      const planeToActiveBearing = planeLatLon.initialBearingTo(activeLatLon);

      const anticipationDistance = this.getAnticipationDistance(planeState, Avionics.Utils.angleDiff(planeToActiveBearing, nextStartTrack));
      if (!nextWaypoint.isFlyover) {
        this.alertIfClose(planeState, distanceToActive, anticipationDistance);

        if (distanceToActive < anticipationDistance && !nextWaypoint.isFlyover) {
          this.sequenceToNextWaypoint(planeState, activeWaypoint);
        }
      }
      
      LNavDirector.trackLeg(previousWaypoint.infos.coordinates, activeWaypoint.infos.coordinates, planeState, distanceToActive > this.options.minimumTrackingDistance);
    }
  }

  /**
   * Handles completing a turn to the next fix.
   * @param {WayPoint} activeWaypoint The current active waypoint.
   * @param {WayPoint} previousWaypoint The current previous waypoint.
   */
  handleTurnCompleting(activeWaypoint, previousWaypoint) {
    const planeState = LNavDirector.getAircraftState();
    const dtk = AutopilotMath.desiredTrack(previousWaypoint.infos.coordinates, activeWaypoint.infos.coordinates, planeState.position);

    const angleDiffToTarget = Avionics.Utils.angleDiff(planeState.trueHeading, dtk);
    if (angleDiffToTarget < this.options.degreesRollout) {
      this.state = LNavState.TRACKING;
    }
    else {
      const turnDirection = Math.sign(angleDiffToTarget);
      const targetHeading = AutopilotMath.normalizeHeading(planeState.trueHeading + (turnDirection * 90));
    
      LNavDirector.trackLeg(previousWaypoint.infos.coordinates, activeWaypoint.infos.coordinates, planeState, false);
      LNavDirector.setCourse(targetHeading, planeState);
    }
  }

  /**
   * Checks to see if the waypoint can be sequenced past.
   * @param {WayPoint} activeWaypoint The waypoint to check against.
   * @returns {boolean} True if it can be sequenced past, false otherwise.
   */
  canSequence(activeWaypoint) {
    return activeWaypoint && !(activeWaypoint.endsInDiscontinuity || activeWaypoint.isRunway);
  }

  /**
   * Alerts the waypoint will be sequenced if within the 5 second sequencing
   * threshold.
   * @param {AircraftState} planeState The current aircraft state.
   * @param {number} distanceToActive The current distance to the active waypoint.
   * @param {number} sequenceDistance The distance where LNAV will sequence to the next waypoint.
   */
  alertIfClose(planeState, distanceToActive, sequenceDistance = 0) {
    const fiveSecondDistance = (planeState.groundSpeed / 3600) * 5;
    if (distanceToActive < sequenceDistance + fiveSecondDistance && this.state !== LNavState.IN_DISCONTINUITY && this.sequencingMode !== FlightPlanSequencing.INHIBIT) {
      SimVar.SetSimVarValue('L:WT_CJ4_WPT_ALERT', 'number', 1);
    }
    else {
      SimVar.SetSimVarValue('L:WT_CJ4_WPT_ALERT', 'number', 0);
    }
  }

  /**
   * Delegates navigation to the holds director, if necessary.
   * @param {WayPoint} activeWaypoint 
   * @returns True if the holds director is now active, false otherwise.
   */
  delegateToHoldsDirector(activeWaypoint) {
    if (activeWaypoint && activeWaypoint.hasHold && !this.holdsDirector.isHoldExited(this.activeFlightPlan.activeWaypointIndex - 1)) {
      this.holdsDirector.update(this.activeFlightPlan.activeWaypointIndex);

      return this.holdsDirector.state !== HoldsDirectorState.NONE && this.holdsDirector.state !== HoldsDirectorState.EXITED;
    }

    return false;
  }

  /**
   * Gets the current turn anticipation distance based on the plane state
   * and next turn angle.
   * @param {AircraftState} planeState The current aircraft state. 
   * @param {number} turnAngle The next turn angle, in degrees.
   */
  getAnticipationDistance(planeState, turnAngle) {
    const turnRadius = AutopilotMath.turnRadius(planeState.groundSpeed, this.options.maxBankAngle);

    const bankDiff = (Math.sign(turnAngle) * this.options.maxBankAngle) - planeState.bankAngle;
    const enterBankDistance = (Math.abs(bankDiff) / this.options.bankRate) * (planeState.groundSpeed / 3600);

    const turnAnticipationAngle = Math.abs(Math.min(this.options.maxTurnAnticipationAngle, turnAngle)) * Avionics.Utils.DEG2RAD;
    return Math.min((turnRadius * Math.tan(turnAnticipationAngle) / 2) + enterBankDistance, this.options.maxTurnAnticipationDistance(planeState));
  }

  /**
   * Handles when the flight plan version changes.
   * @param {number} currentFlightPlanVersion The new current flight plan version.
   */
  handleFlightPlanChanged(currentFlightPlanVersion) {
    this.activeFlightPlan = this.fpm.getFlightPlan(0);
    const activeWaypoint = this.activeFlightPlan.getWaypoint(this.activeFlightPlan.activeWaypointIndex);

    if (this.state === LNavState.TURN_COMPLETING) {
      this.state === LNavState.TRACKING;
    }

    if (this.sequencingMode === FlightPlanSequencing.INHIBIT) {
      this.sequencingMode = FlightPlanSequencing.AUTO;
    }

    if (this.state === LNavState.IN_DISCONTINUITY && !(activeWaypoint && activeWaypoint.endsInDiscontinuity)) {
      SimVar.SetSimVarValue("L:WT_CJ4_IN_DISCONTINUITY", "number", 0);
      this.state = LNavState.TRACKING;
    }

    SimVar.SetSimVarValue('L:WT_CJ4_WPT_ALERT', 'number', 0);
    this.currentFlightPlanVersion = currentFlightPlanVersion;
  }

  /**
   * Sequences to the next waypoint in the flight plan.
   * @param {AircraftState} planeState The current aircraft state.
   * @param {WayPoint} currentWaypoint The current active waypoint.
   */
  sequenceToNextWaypoint(planeState, currentWaypoint) {
    if (this.sequencingMode !== FlightPlanSequencing.INHIBIT && planeState.groundSpeed > 25) {
      const nextWaypoint = this.fpm.getWaypoint(this.activeFlightPlan.activeWaypointIndex + 1);

      if (currentWaypoint && currentWaypoint.endsInDiscontinuity) {
        this.state = LNavState.IN_DISCONTINUITY;
        SimVar.SetSimVarValue("L:WT_CJ4_IN_DISCONTINUITY", "number", 1);

        this.sequencingMode = FlightPlanSequencing.INHIBIT;
        LNavDirector.setCourse(SimVar.GetSimVarValue('PLANE HEADING DEGREES TRUE', 'Radians') * Avionics.Utils.RAD2DEG, planeState);
      }
      else if (nextWaypoint && nextWaypoint.isRunway) {
        this.sequencingMode = FlightPlanSequencing.INHIBIT;
        
        this.state = LNavState.TURN_COMPLETING;
        this.fpm.setActiveWaypointIndex(this.activeFlightPlan.activeWaypointIndex + 1);
      }
      else {
        this.state = LNavState.TURN_COMPLETING;
        this.fpm.setActiveWaypointIndex(this.activeFlightPlan.activeWaypointIndex + 1);
      }
    }
  }

  /**
   * Sets LNAV sequencing to AUTO.
   */
  setAutoSequencing() {
    const activeWaypoint = this.activeFlightPlan.getWaypoint(this.activeFlightPlan.activeWaypointIndex);
    if (this.state === LNavState.IN_DISCONTINUITY || (activeWaypoint && activeWaypoint.isRunway)) {
      this.state = LNavState.TRACKING;
      SimVar.SetSimVarValue("L:WT_CJ4_IN_DISCONTINUITY", "number", 0);

      const nextWaypointIndex = this.activeFlightPlan.activeWaypointIndex + 1;

      this.fpm.setActiveWaypointIndex(nextWaypointIndex);
      this.fpm.clearDiscontinuity(nextWaypointIndex - 1);
    }

    this.sequencingMode = FlightPlanSequencing.AUTO;
  }

  /**
   * Sets LNAV sequencing to INHIBIT.
   */
  setInhibitSequencing() {
    this.sequencingMode = FlightPlanSequencing.INHIBIT;
  }

  /**
   * Tracks the specified leg.
   * @param {LatLongAlt} legStart The coordinates of the start of the leg.
   * @param {LatLongAlt} legEnd The coordinates of the end of the leg.
   * @param {AircraftState} planeState The current aircraft state.
   * @param {boolean} execute Whether or not to execute the calculated course.
   */
  static trackLeg(legStart, legEnd, planeState, execute = true) {
    const dtk = AutopilotMath.desiredTrack(legStart, legEnd, planeState.position);
    const xtk = AutopilotMath.crossTrack(legStart, legEnd, planeState.position);

    const correctedDtk = GeoMath.correctMagvar(dtk, SimVar.GetSimVarValue("MAGVAR", "degrees"));

    SimVar.SetSimVarValue("L:WT_CJ4_XTK", "number", xtk);
    SimVar.SetSimVarValue("L:WT_CJ4_DTK", "number", correctedDtk);

    const interceptAngle = AutopilotMath.interceptAngle(xtk, NavSensitivity.NORMAL);
    const bearingToWaypoint = Avionics.Utils.computeGreatCircleHeading(planeState.position, legEnd);
    const deltaAngle = Math.abs(Avionics.Utils.angleDiff(dtk, bearingToWaypoint));

    const headingToSet = deltaAngle < Math.abs(interceptAngle) ? AutopilotMath.normalizeHeading(dtk + interceptAngle) : bearingToWaypoint;

    if (execute) {
      LNavDirector.setCourse(headingToSet, planeState);
    }
  }

  /**
   * Sets the autopilot course to fly.
   * @param {number} degreesTrue The track in degrees true for the autopilot to fly.
   * @param {AircraftState} planeState The current state of the aircraft.
   */
  static setCourse(degreesTrue, planeState) {
    const currWindDirection = GeoMath.removeMagvar(planeState.windDirection, planeState.magVar);
    const windCorrection = AutopilotMath.windCorrectionAngle(degreesTrue, planeState.trueAirspeed, currWindDirection, planeState.windSpeed);

    let targetHeading = AutopilotMath.normalizeHeading(degreesTrue - windCorrection);
    targetHeading = GeoMath.correctMagvar(targetHeading, planeState.magVar);

    Coherent.call("HEADING_BUG_SET", 2, targetHeading);
  }

  /**
   * Gets the current state of the aircraft.
   */
  static getAircraftState() {
    const state = new AircraftState();
    state.position = new LatLongAlt(SimVar.GetSimVarValue("GPS POSITION LAT", "degree latitude"), SimVar.GetSimVarValue("GPS POSITION LON", "degree longitude"));
    state.magVar = SimVar.GetSimVarValue("MAGVAR", "degrees");

    state.groundSpeed = SimVar.GetSimVarValue("GPS GROUND SPEED", "knots");
    state.trueAirspeed = SimVar.GetSimVarValue('AIRSPEED TRUE', 'knots');

    state.windDirection = SimVar.GetSimVarValue("AMBIENT WIND DIRECTION", "degrees");
    state.windSpeed = SimVar.GetSimVarValue("AMBIENT WIND VELOCITY", "knots");

    state.trueHeading = SimVar.GetSimVarValue('PLANE HEADING DEGREES TRUE', 'Radians') * Avionics.Utils.RAD2DEG;
    state.magneticHeading = SimVar.GetSimVarValue('PLANE HEADING DEGREES MAGNETIC', 'Radians') * Avionics.Utils.RAD2DEG;
    state.trueTrack = SimVar.GetSimVarValue('GPS GROUND TRUE TRACK', 'Radians') * Avionics.Utils.RAD2DEG;
    
    state.bankAngle = SimVar.GetSimVarValue('PLANE BANK DEGREES', 'Radians') * Avionics.Utils.RAD2DEG;

    return state;
  }
}

/**
 * Options for lateral navigation.
 */
class LNavDirectorOptions {

  /**
   * Creates an instance of LNavDirectorOptions.
   */
  constructor() {
    /** 
     * The minimum distance in NM that LNAV will track towards the active waypoint. This
     * value is used to avoid swinging towards the active waypoint when the waypoint is close,
     * if the plane is off track.
     */
    this.minimumTrackingDistance = 1;

    /** The maximum bank angle of the aircraft. */
    this.maxBankAngle = 30;

    /** The rate of bank in degrees per second. */
    this.bankRate = 10;

    /** The maximum turn angle in degrees to calculate turn anticipation to. */
    this.maxTurnAnticipationAngle = 110;

    /** A function that returns the maximum turn anticipation distance. */
    this.maxTurnAnticipationDistance = (planeState) => planeState.trueAirspeed < 350 ? 7 : 10;

    /** The number of degrees left in the turn that turn completion will stop and rollout/tracking will begin. */
    this.degreesRollout = 15;
  }
}

/**
 * The current state of the aircraft for LNAV.
 */
class AircraftState {
  constructor() {
    /** 
     * The true airspeed of the plane. 
     * @type {number}
     */
    this.trueAirspeed = undefined;

    /**
     * The ground speed of the plane.
     * @type {number}
     */
    this.groundSpeed = undefined;

    /**
     * The current plane location magvar.
     * @type {number}
     */
    this.magVar = undefined;

    /**
     * The current plane position.
     * @type {LatLonAlt}
     */
    this.position = undefined;

    /**
     * The wind speed.
     * @type {number}
     */
    this.windSpeed = undefined;

    /**
     * The wind direction.
     * @type {number}
     */
    this.windDirection = undefined;

    /**
     * The current heading in degrees true of the plane.
     * @type {number}
     */
    this.trueHeading = undefined;

    /**
     * The current heading in degrees magnetic of the plane.
     * @type {number}
     */
    this.magneticHeading = undefined;

    /**
     * The current track in degrees true of the plane.
     * @type {number}
     */
    this.trueTrack = undefined;

    /**
     * The current plane bank angle.
     * @type {number}
     */
    this.bankAngle = undefined;
  }
}

class FlightPlanSequencing { }
FlightPlanSequencing.AUTO = 'AUTO';
FlightPlanSequencing.INHIBIT = 'INHIBIT';

class LNavState { }
LNavState.TRACKING = 'TRACKING';
LNavState.TURN_COMPLETING = 'TURN_COMPLETING';
LNavState.IN_DISCONTINUITY = 'IN_DISCONTINUITY';

/** The sensitivity of the navigation solution. */
class NavSensitivity { }
/** Vertical and lateral sensitivity is at normal +/- 2.0NM enroute levels. */
NavSensitivity.NORMAL = 0;
/** Vertical and lateral sensitivity is at +/- 1.0NM terminal levels. */
NavSensitivity.TERMINAL = 1;
/** Vertical and lateral sensitivity is at +/- 1.0NM terminal levels. */
NavSensitivity.TERMINALLPV = 2;
/** Vertical and lateral sensitivity is at +/- 0.3NM approach levels. */
NavSensitivity.APPROACH = 3;
/** Vertical and lateral sensitivity increases as distance remaining on final decreases. */
NavSensitivity.APPROACHLPV = 4;
