const Workflow = require("@saltcorn/data/models/workflow");
const Form = require("@saltcorn/data/models/form");
const Table = require("@saltcorn/data/models/table");
const View = require("@saltcorn/data/models/view");
const User = require("@saltcorn/data/models/user");
const {
  eval_expression,
  add_free_variables_to_joinfields,
  freeVariables,
} = require("@saltcorn/data/models/expression");
const { getState, features } = require("@saltcorn/data/db/state");

const axios = require("axios");
const { createHash, createHmac } = require("crypto");
const configuration_workflow = () => {
  const cfg_base_url = getState().getConfig("base_url");

  return new Workflow({
    steps: [
      {
        name: "Mauapay configuration",
        form: () =>
          new Form({
            labelCols: 3,
            blurb: !cfg_base_url
              ? "You should set the 'Base URL' configration property. "
              : "",
            fields: [
              {
                name: "publishableKey",
                label: "Publishable API key",
                type: "String",
                required: true,
              },
              {
                name: "secretKey",
                label: "Secret API key",
                type: "String",
                required: true,
              },
            ],
          }),
      },
    ],
  });
};

// user subscribe action
const actions = ({ publishableKey, secretKey }) => ({
  mauapay_payment_request: {
    configFields: async ({ table }) => {
      const fields = table ? await table.getFields() : [];
      const cbviews = await View.find({ viewtemplate: "MauaPay Callback" });
      const amount_options = fields
        .filter((f) => ["Float", "Integer"].includes(f.type?.name))
        .map((f) => f.name);
      for (const field of fields) {
        if (field.is_fkey) {
          Table.findOne({
            name: field.reftable_name,
          })
            .fields.filter((f) => ["Float", "Integer"].includes(f.type?.name))
            .forEach((f) => amount_options.push(`${field.name}.${f.name}`));
        }
      }
      amount_options.push("Formula");
      return [
        {
          name: "order_id_field",
          label: "OrderID field",
          type: "String",
          required: true,
          attributes: {
            options: fields.map((f) => f.name),
          },
        },
        {
          name: "reference_id_field",
          label: "Reference ID field",
          type: "String",
          sublabel: "A String field. Will be filled by Mauapay transaction",
          required: true,
          attributes: {
            options: fields
              .filter((f) => f.type?.name === "String")
              .map((f) => f.name),
          },
        },
        {
          name: "amount_field",
          label: "Amount field",
          type: "String",
          required: true,
          attributes: {
            options: amount_options,
          },
        },
        {
          name: "amount_formula",
          label: "Amount formula",
          type: "String",
          required: true,
          fieldview: "textarea",
          class: "validate-expression",
          showIf: { amount_field: "Formula" },
        },
        {
          name: "skip_if",
          label: "Skip if",
          sublabel: "Do not process payment if this formula evaluates to true",
          type: "String",
          class: "validate-expression",
        },
        {
          name: "currency",
          label: "Currency",
          type: "String",
          required: true,
          attributes: {
            options: ["WST", "AUD", "NZD", "USD"],
          },
        },
        {
          name: "payment_service",
          label: "Payment Service",
          type: "String",
          required: true,
          attributes: {
            options: ["digicel", "vodafone"],
          },
        },
        {
          name: "callback_view",
          label: "Callback view",
          type: "String",
          required: true,
          attributes: {
            options: cbviews.map((f) => f.name),
          },
        },
      ];
    },
    run: async ({
      table,
      req,
      user,
      row,
      configuration: {
        order_id_field,
        amount_field,
        amount_formula,
        callback_view,
        reference_id_field,
        currency,
        skip_if,
        payment_service,
      },
    }) => {
      if (skip_if && eval_expression(skip_if, row, user || req?.user))
        return {};
      const cfg_base_url = getState().getConfig("base_url");
      const cb_url = `${cfg_base_url}view/${callback_view}`;
      const orderID = row[order_id_field];
      console.log({
        amount_field,
        amount_formula,
        callback_view,
        reference_id_field,
        currency,
        row,
      });
      let amount;
      if (amount_field === "Formula") {
        const joinFields = {};
        add_free_variables_to_joinfields(
          freeVariables(amount_formula),
          joinFields,
          table.fields
        );
        let row_eval;
        if (Object.keys(joinFields).length > 0)
          row_eval = (
            await table.getJoinedRows({
              where: { id: row.id },
              joinFields,
            })
          )[0];
        else row_eval = row;

        amount = eval_expression(amount_formula, row_eval, req?.user).toFixed(
          2
        );
      } else if (amount_field.includes(".")) {
        const amt_fk_field = table.getField(amount_field);
        const amt_table = Table.findOne(amt_fk_field.table_id);
        const amt_row = await amt_table.getRow({
          [amt_table.pk_name]: row[amount_field.split(".")[0]],
        });
        amount = amt_row[amt_fk_field.name].toFixed(2);
      } else amount = row[amount_field].toFixed(2);

      const paymentService = payment_service || "digicel";
      const checkStr = `${orderID}:${amount}:${cb_url}:${cb_url}:${cb_url}:${cb_url}:${paymentService}`;

      const checksum = createHmac("sha256", secretKey)
        .update(checkStr)
        .digest("hex");
      const form = new URLSearchParams({});
      console.log({ cb_url });
      form.append("orderID", orderID);
      form.append("amount", amount);
      form.append("successURL", cb_url);
      form.append("failureURL", cb_url);
      form.append("processingURL", cb_url);
      form.append("cancellationURL", cb_url);
      form.append("paymentService", paymentService);
      form.append("checksum", checksum);
      form.append("settlementCurrency", currency || "WST");
      form.append("currency", currency || "WST");
      const headers = {
        "Content-Type": "application/x-www-form-urlencoded",
        "x-business-publishable-key": publishableKey,
      };
      console.log("mauapay form", form, headers);
      try {
        const { data } = await axios({
          method: "post",
          url: "https://api.mauapay.com/api/v1/transactions",
          data: form,
          headers,
        });
        console.log("fetchres", data);
        const need_response_checksum = createHmac("sha256", secretKey)
          .update(`${data.token}:${data.referenceID}`)
          .digest("hex");
        if (data.checksum !== need_response_checksum) {
          console.error("checksum mismatch", need_response_checksum);
          return { error: "Payment integration response not verified" };
        }
        await table.updateRow(
          { [reference_id_field]: data.referenceID },
          row.id
        );
        return {
          goto: `https://www.mauapay.com/end-point?token=${data.token}`,
        };
      } catch (e) {
        console.error(e);
        console.error("checksum string", checkStr);
        console.error("request configuration", e.config);
        console.error("response data", e.response?.data);
        return { error: e.response?.data?.message || e.message };
      }
    },
  },
});

const viewtemplates = ({ publishableKey, secretKey }) => {
  return [
    {
      name: "MauaPay Callback",
      display_state_form: false,
      configuration_workflow: () =>
        new Workflow({
          steps: [
            {
              name: "Callback configuration",
              disablePreview: true,
              form: async (context) => {
                const table = Table.findOne({ id: context.table_id });
                const views = await View.find({ table_id: table.id });
                return new Form({
                  fields: [
                    {
                      name: "reference_id_field",
                      label: "Reference ID field",
                      type: "String",
                      required: true,
                      attributes: {
                        options: table.fields
                          .filter((f) => f.type?.name === "String")
                          .map((f) => f.name),
                      },
                    },
                    {
                      name: "paid_field",
                      label: "Paid field",
                      type: "String",
                      sublabel:
                        "Optionally, a Boolean field that will be set to true if paid",
                      attributes: {
                        options: table.fields
                          .filter((f) => f.type?.name === "Bool")
                          .map((f) => f.name),
                      },
                    },
                    {
                      name: "status_field",
                      label: "Status field",
                      type: "String",
                      sublabel:
                        "Optionally, a String field that will be set to status: cancelled, paid, failed, processing",
                      attributes: {
                        options: table.fields
                          .filter((f) => f.type?.name === "String")
                          .map((f) => f.name),
                      },
                    },
                    {
                      name: "success_view",
                      label: "Success view",
                      type: "String",
                      required: true,
                      attributes: {
                        options: views
                          .filter((v) => v.name !== context.viewname)
                          .map((v) => v.name),
                      },
                    },
                    {
                      name: "cancelled_view",
                      label: "Cancelled view",
                      type: "String",
                      required: true,
                      attributes: {
                        options: views
                          .filter((v) => v.name !== context.viewname)
                          .map((v) => v.name),
                      },
                    },
                    {
                      name: "failure_view",
                      label: "Failure view",
                      type: "String",
                      required: true,
                      attributes: {
                        options: views
                          .filter((v) => v.name !== context.viewname)
                          .map((v) => v.name),
                      },
                    },
                    {
                      name: "processing_view",
                      label: "Processing view",
                      type: "String",
                      required: true,
                      attributes: {
                        options: views
                          .filter((v) => v.name !== context.viewname)
                          .map((v) => v.name),
                      },
                    },
                  ],
                });
              },
            },
          ],
        }),
      get_state_fields: () => [],
      run: async (
        table_id,
        viewname,
        {
          reference_id_field,
          paid_field,
          status_field,
          cancelled_view,
          success_view,
          processing_view,
          failure_view,
        },
        state,
        { req, res }
      ) => {
        console.log("state", state);
        const checkStr = `${state.token}:${state.referenceID}:${state.status}`;
        const need_response_checksum = createHmac("sha256", secretKey)
          .update(checkStr)
          .digest("hex");
        if (state.checksum !== need_response_checksum) {
          console.error("checksum mismatch", need_response_checksum, checkStr);
          return "Payment integration response not verified";
        }

        const table = Table.findOne({ id: table_id });
        const row = await table.getRow({
          [reference_id_field]: state.referenceID,
        });
        const upd = {};
        if (status_field) upd[status_field] = state.status;
        if (paid_field && state.status === "paid") upd[paid_field] = true;
        if (Object.keys(upd).length > 0)
          await table.updateRow(upd, row[table.pk_name]);
        const pk = table.pk_name;

        const dest_url = {
          cancelled: `/view/${cancelled_view}?${pk}=${row[pk]}`,
          paid: `/view/${success_view}?${pk}=${row[pk]}`,
          failure: `/view/${failure_view}?${pk}=${row[pk]}`,
          processing: `/view/${processing_view}?${pk}=${row[pk]}`,
        }[state.status];

        if (!dest_url) return "Unknown status: " + state.status;

        if (features?.get_view_goto)
          return {
            goto: dest_url,
          };
        res.redirect(dest_url);
        return;
      },
    },
  ];
};

module.exports = {
  sc_plugin_api_version: 1,
  configuration_workflow,
  actions,
  viewtemplates,
};
