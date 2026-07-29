/**
 * Regression fixture for the fill engine.
 *
 * Every step is deliberately built to reproduce one of the failure modes the
 * rework addresses:
 *
 *  1. Node recycling: all four steps render the same `<StepFields>` component
 *     shape, so React reuses the identical `<input>` DOM nodes across steps.
 *     An element-keyed synthetic id makes step 2 look already-filled.
 *  2. Controlled inputs: values live in React state, so a plain `el.value = x`
 *     write is reverted on the next render.
 *  3. Conditional fields gated on a checkbox, which only appear after the box
 *     is checked and the component re-renders.
 *  4. A radio group whose values differ from its labels.
 *  5. A native select with numeric values and human labels.
 *  6. An ARIA combobox with no native select behind it.
 *  7. A validation gate that refuses to advance and reports `aria-invalid`
 *     plus a `role="alert"` message.
 */

import React, { useCallback, useMemo, useRef, useState } from "https://esm.sh/react@18.3.1";
import { createRoot } from "https://esm.sh/react-dom@18.3.1/client";

const STEPS = ["Contact", "Delivery", "Preferences", "Review"];

const PREFECTURES = [
  { value: "13", label: "Tokyo" },
  { value: "27", label: "Osaka" },
  { value: "01", label: "Hokkaido" },
  { value: "40", label: "Fukuoka" },
];

const PLANS = [
  { value: "p_basic", label: "Basic - 1 user" },
  { value: "p_team", label: "Team - up to 20 users" },
  { value: "p_ent", label: "Enterprise - unlimited" },
];

const TOPICS = ["Product updates", "Security advisories", "Billing", "Community events"];

const TIME_SLOTS = ["Morning (9-12)", "Afternoon (12-17)", "Evening (17-21)"];

// ---------------------------------------------------------------------------
// Field primitives
// ---------------------------------------------------------------------------

function TextField({ id, label, type = "text", value, onChange, required, error, hint, ...rest }) {
  return (
    <div className="field">
      <label className={required ? "req" : undefined} htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        name={id}
        type={type}
        value={value}
        required={required}
        aria-invalid={error ? "true" : undefined}
        aria-describedby={error ? `${id}-err` : hint ? `${id}-hint` : undefined}
        onChange={(event) => onChange(event.target.value)}
        {...rest}
      />
      {hint && !error ? (
        <p className="hint" id={`${id}-hint`}>
          {hint}
        </p>
      ) : null}
      {error ? (
        <p className="error" id={`${id}-err`} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function SelectField({ id, label, options, value, onChange, required, error }) {
  return (
    <div className="field">
      <label className={required ? "req" : undefined} htmlFor={id}>
        {label}
      </label>
      <select
        id={id}
        name={id}
        value={value}
        required={required}
        aria-invalid={error ? "true" : undefined}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">Please select</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** Values intentionally differ from labels, so label-only answers must resolve. */
function RadioGroup({ name, legend, options, value, onChange, required, error }) {
  return (
    <fieldset>
      <legend className={required ? "req" : undefined}>{legend}</legend>
      {options.map((option) => (
        <div className="field" key={option.value}>
          <label className="inline" htmlFor={`${name}-${option.value}`}>
            <input
              id={`${name}-${option.value}`}
              type="radio"
              name={name}
              value={option.value}
              checked={value === option.value}
              required={required}
              onChange={() => onChange(option.value)}
            />
            <span>{option.label}</span>
          </label>
        </div>
      ))}
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}

function CheckboxGroup({ legend, items, selected, onToggle, max }) {
  return (
    <fieldset data-max={max ?? undefined}>
      <legend>{legend}</legend>
      {items.map((item) => (
        <div className="field" key={item}>
          <label className="inline">
            <input
              type="checkbox"
              name={item}
              checked={selected.includes(item)}
              onChange={(event) => onToggle(item, event.target.checked)}
            />
            <span>{item}</span>
          </label>
        </div>
      ))}
      {max ? <p className="hint">Choose at most {max}.</p> : null}
    </fieldset>
  );
}

/** No native select behind this: state lives entirely in ARIA attributes. */
function AriaCombobox({ id, label, options, value, onChange, required }) {
  const [open, setOpen] = useState(false);
  const selected = options.find((option) => option.value === value);

  return (
    <div className="field combo">
      <label className={required ? "req" : undefined} id={`${id}-label`}>
        {label}
      </label>
      <button
        type="button"
        id={id}
        role="combobox"
        aria-expanded={open}
        aria-controls={`${id}-listbox`}
        aria-labelledby={`${id}-label`}
        aria-required={required ? "true" : undefined}
        onClick={() => setOpen((prev) => !prev)}
      >
        {selected ? selected.label : "Select a country"}
      </button>
      {open ? (
        <ul role="listbox" id={`${id}-listbox`} aria-labelledby={`${id}-label`}>
          {options.map((option) => (
            <li
              key={option.value}
              role="option"
              data-value={option.value}
              aria-selected={option.value === value}
              onClick={() => {
                onChange(option.value);
                setOpen(false);
              }}
            >
              {option.label}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function AriaSwitch({ id, label, checked, onChange }) {
  return (
    <div className="field">
      <span
        id={id}
        role="switch"
        tabIndex={0}
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        onKeyDown={(event) => {
          if (event.key === " " || event.key === "Enter") {
            event.preventDefault();
            onChange(!checked);
          }
        }}
      >
        <span className="track" aria-hidden="true" />
        <span>{label}</span>
      </span>
    </div>
  );
}

const COUNTRIES = [
  { value: "jp", label: "Japan" },
  { value: "de", label: "Germany" },
  { value: "br", label: "Brazil" },
  { value: "us", label: "United States" },
];

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

function StepContact({ data, set, errors }) {
  return (
    <fieldset>
      <legend>Your details</legend>
      <TextField
        id="fullName"
        label="Full name"
        value={data.fullName}
        onChange={(value) => set("fullName", value)}
        required
        error={errors.fullName}
      />
      <TextField
        id="email"
        label="Email address"
        type="email"
        value={data.email}
        onChange={(value) => set("email", value)}
        required
        error={errors.email}
      />
      <TextField
        id="phone"
        label="Phone number"
        type="tel"
        value={data.phone}
        onChange={(value) => set("phone", value)}
        required
        pattern="0\d{2}-\d{4}-\d{4}"
        hint="Format: 090-1234-5678"
        error={errors.phone}
      />
    </fieldset>
  );
}

function StepDelivery({ data, set, errors }) {
  return (
    <>
      <fieldset>
        <legend>Delivery address</legend>
        <TextField
          id="street"
          label="Street address"
          value={data.street}
          onChange={(value) => set("street", value)}
          required
          error={errors.street}
        />
        <SelectField
          id="prefecture"
          label="Prefecture"
          options={PREFECTURES}
          value={data.prefecture}
          onChange={(value) => set("prefecture", value)}
          required
          error={errors.prefecture}
        />
        <AriaCombobox
          id="country"
          label="Country"
          options={COUNTRIES}
          value={data.country}
          onChange={(value) => set("country", value)}
          required
        />
      </fieldset>

      <RadioGroup
        name="deliverySpeed"
        legend="Delivery speed"
        options={[
          { value: "spd_std", label: "Standard (3-5 days)" },
          { value: "spd_exp", label: "Express (next day)" },
          { value: "spd_pick", label: "Collect in store" },
        ]}
        value={data.deliverySpeed}
        onChange={(value) => set("deliverySpeed", value)}
        required
        error={errors.deliverySpeed}
      />

      <fieldset>
        <legend>Instructions</legend>
        <div className="field">
          <label className="inline">
            <input
              type="checkbox"
              name="hasInstructions"
              checked={data.hasInstructions}
              onChange={(event) => set("hasInstructions", event.target.checked)}
            />
            <span>I have special delivery instructions</span>
          </label>
        </div>
        {/* Only rendered once the box above is checked. */}
        {data.hasInstructions ? (
          <TextField
            id="instructions"
            label="Delivery instructions"
            value={data.instructions}
            onChange={(value) => set("instructions", value)}
            required
            error={errors.instructions}
          />
        ) : null}
      </fieldset>
    </>
  );
}

function StepPreferences({ data, set, errors, toggleTopic }) {
  return (
    <>
      <fieldset>
        <legend>Plan</legend>
        <SelectField
          id="plan"
          label="Subscription plan"
          options={PLANS}
          value={data.plan}
          onChange={(value) => set("plan", value)}
          required
          error={errors.plan}
        />
        <TextField
          id="seats"
          label="Number of seats"
          type="number"
          min="1"
          max="20"
          value={data.seats}
          onChange={(value) => set("seats", value)}
          required
          error={errors.seats}
        />
        <TextField
          id="startDate"
          label="Start date"
          type="date"
          value={data.startDate}
          onChange={(value) => set("startDate", value)}
          required
          error={errors.startDate}
        />
      </fieldset>

      <CheckboxGroup
        legend="Email topics"
        items={TOPICS}
        selected={data.topics}
        onToggle={toggleTopic}
        max={2}
      />

      <RadioGroup
        name="contactSlot"
        legend="Preferred contact time"
        options={TIME_SLOTS.map((slot, index) => ({ value: `slot_${index}`, label: slot }))}
        value={data.contactSlot}
        onChange={(value) => set("contactSlot", value)}
      />

      <fieldset>
        <legend>Notifications</legend>
        <AriaSwitch
          id="smsOptIn"
          label="Send me SMS reminders"
          checked={data.smsOptIn}
          onChange={(value) => set("smsOptIn", value)}
        />
        <div className="field">
          <label htmlFor="notes">Anything else we should know?</label>
          <textarea
            id="notes"
            name="notes"
            value={data.notes}
            maxLength={300}
            onChange={(event) => set("notes", event.target.value)}
          />
        </div>
      </fieldset>
    </>
  );
}

function StepReview({ data, set, errors }) {
  return (
    <fieldset>
      <legend>Confirm and submit</legend>
      {/* Must match the step 1 value, exercising cross-step context. */}
      <TextField
        id="confirmEmail"
        label="Re-enter your email address"
        type="email"
        value={data.confirmEmail}
        onChange={(value) => set("confirmEmail", value)}
        required
        error={errors.confirmEmail}
      />
      <div className="field">
        <label className="inline">
          <input
            type="checkbox"
            name="acceptTerms"
            checked={data.acceptTerms}
            onChange={(event) => set("acceptTerms", event.target.checked)}
            required
          />
          <span>I accept the terms of service</span>
        </label>
        {errors.acceptTerms ? (
          <p className="error" role="alert">
            {errors.acceptTerms}
          </p>
        ) : null}
      </div>
    </fieldset>
  );
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const PHONE_PATTERN = /^0\d{2}-\d{4}-\d{4}$/;

function validateStep(step, data) {
  const errors = {};

  if (step === 0) {
    if (!data.fullName.trim()) errors.fullName = "Full name is required.";
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(data.email)) {
      errors.email = "Enter a valid email address.";
    }
    if (!PHONE_PATTERN.test(data.phone)) {
      errors.phone = "Phone must look like 090-1234-5678.";
    }
  }

  if (step === 1) {
    if (!data.street.trim()) errors.street = "Street address is required.";
    if (!data.prefecture) errors.prefecture = "Choose a prefecture.";
    if (!data.country) errors.country = "Choose a country.";
    if (!data.deliverySpeed) errors.deliverySpeed = "Choose a delivery speed.";
    if (data.hasInstructions && !data.instructions.trim()) {
      errors.instructions = "Describe your delivery instructions.";
    }
  }

  if (step === 2) {
    if (!data.plan) errors.plan = "Choose a plan.";
    const seats = Number(data.seats);
    if (!Number.isFinite(seats) || seats < 1 || seats > 20) {
      errors.seats = "Seats must be between 1 and 20.";
    }
    if (!data.startDate) errors.startDate = "Choose a start date.";
  }

  if (step === 3) {
    if (data.confirmEmail.trim().toLowerCase() !== data.email.trim().toLowerCase()) {
      errors.confirmEmail = "This must match the email you entered in step 1.";
    }
    if (!data.acceptTerms) errors.acceptTerms = "You must accept the terms.";
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Wizard
// ---------------------------------------------------------------------------

const INITIAL = {
  fullName: "",
  email: "",
  phone: "",
  street: "",
  prefecture: "",
  country: "",
  deliverySpeed: "",
  hasInstructions: false,
  instructions: "",
  plan: "",
  seats: "",
  startDate: "",
  topics: [],
  contactSlot: "",
  smsOptIn: false,
  notes: "",
  confirmEmail: "",
  acceptTerms: false,
};

function Wizard() {
  const [step, setStep] = useState(0);
  const [data, setData] = useState(INITIAL);
  const [errors, setErrors] = useState({});
  const [submitted, setSubmitted] = useState(null);
  const attempts = useRef(0);

  const set = useCallback((key, value) => {
    setData((prev) => ({ ...prev, [key]: value }));
    setErrors((prev) => (prev[key] ? { ...prev, [key]: undefined } : prev));
  }, []);

  const toggleTopic = useCallback((topic, checked) => {
    setData((prev) => ({
      ...prev,
      topics: checked ? [...prev.topics, topic] : prev.topics.filter((item) => item !== topic),
    }));
  }, []);

  const onNext = () => {
    attempts.current += 1;
    const found = validateStep(step, data);
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    if (step === STEPS.length - 1) {
      setSubmitted(data);
      return;
    }
    setStep((prev) => prev + 1);
  };

  const onBack = () => {
    setErrors({});
    setStep((prev) => Math.max(0, prev - 1));
  };

  const body = useMemo(() => {
    const props = { data, set, errors, toggleTopic };
    if (step === 0) return <StepContact {...props} />;
    if (step === 1) return <StepDelivery {...props} />;
    if (step === 2) return <StepPreferences {...props} />;
    return <StepReview {...props} />;
  }, [step, data, errors, set, toggleTopic]);

  if (submitted) {
    return (
      <div className="shell">
        <h1>Submitted</h1>
        <div className="summary">
          <h2>All four steps completed</h2>
          <pre>{JSON.stringify(submitted, null, 2)}</pre>
        </div>
        <div className="actions">
          <button
            type="button"
            onClick={() => {
              setSubmitted(null);
              setData(INITIAL);
              setStep(0);
              attempts.current = 0;
            }}
          >
            Reset fixture
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="shell">
      <h1>Multi-step reactive form</h1>
      <p className="lead">
        Regression fixture: recycled DOM nodes, controlled inputs, checkbox-gated fields, a radio
        group, a numeric-valued select, an ARIA combobox and a switch.
      </p>

      <ol className="stepper">
        {STEPS.map((name, index) => (
          <li
            key={name}
            className={index === step ? "active" : undefined}
            aria-current={index === step ? "step" : undefined}
            data-step-index={index}
          >
            {index + 1}. {name}
          </li>
        ))}
      </ol>

      <form
        className="card"
        data-total-steps={STEPS.length}
        onSubmit={(event) => {
          event.preventDefault();
          onNext();
        }}
      >
        {body}

        <div className="actions">
          <button type="button" onClick={onBack} disabled={step === 0}>
            Back
          </button>
          <button type="submit" className="primary">
            {step === STEPS.length - 1 ? "Submit order" : "Next step"}
          </button>
        </div>
      </form>

      <div className="checklist">
        <h2>What a passing run looks like</h2>
        <ol>
          <li>All four steps are traversed without a manual re-run.</li>
          <li>The phone number matches 0XX-XXXX-XXXX on the first or second attempt.</li>
          <li>The prefecture select lands on a real option despite its numeric values.</li>
          <li>Checking the instructions box reveals a field that then gets filled.</li>
          <li>At most two email topics are selected.</li>
          <li>Step 4's email confirmation matches the address from step 1.</li>
        </ol>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")).render(<Wizard />);
