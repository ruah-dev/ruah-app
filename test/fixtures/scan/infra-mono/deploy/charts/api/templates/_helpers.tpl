{{- define "api.fullname" -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- define "api.selectorLabels" -}}
app.kubernetes.io/name: api
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}
{{- define "api.labels" -}}
{{ include "api.selectorLabels" . }}
{{- end }}
